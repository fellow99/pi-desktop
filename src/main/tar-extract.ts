import { createGunzip } from 'node:zlib';
import { createReadStream, mkdirSync, openSync, closeSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * tar-extract.ts — 真正流式的 ustar(.gz) 解压器（固定内存，O(n)）。
 *
 * 来源：`pi-desktop-hos/src-main/tar-extract.js`（真机验证过的移植版，本文件是它的 TypeScript 版）。
 *
 * 为什么独立成模块：
 *   常见「流式」实现会把**整个 tar 条目**缓冲进一块 Buffer 后才落盘，并在每个 gunzip chunk
 *   上 Buffer.concat 全量复制 → 对超大条目退化为 O(n²) 内存拷贝（真机上单核 100% 且永不结束）。
 *   本模块用「header / data / padding」状态机：header 最多缓冲 512 字节，文件数据随到随写，
 *   内存占用不随条目大小增长。
 *
 * 打包约定（与 scripts/collect-pi.mjs 一致）：
 *   归档用 `tar -czf pi-dist.tar.gz -C <staging> pi-dist` 生成，条目带 `pi-dist/` 前缀；
 *   解压目标是 `<userData>/pi-dist`，因此解析时剥掉该前缀（避免双重前缀）。
 */

const HEADER_SIZE = 512;

export type Sink = { write(buf: Buffer): void; end(): void };

export type UstarHandlers = {
  onDirectory?: (name: string) => void;
  onFile?: (name: string) => Sink;
  onSkip?: (name: string, size: number) => void;
};

export type UstarParser = {
  push(chunk: Buffer): void;
  finish(): void;
  readonly count: number;
};

type HeaderMeta = { name: string; type: 'dir' | 'file' | 'skip'; size: number };

function readHeader(header: Buffer): HeaderMeta {
  const cstr = (start: number, end: number): string =>
    header.subarray(start, end).toString('utf8').replace(/\0[\s\S]*$/, '');

  const rawName = cstr(0, 100);
  const prefix = cstr(345, 500);
  const size = parseInt(cstr(124, 136).trim(), 8) || 0;
  const typeflag = String.fromCharCode(header[156]);

  let fullName = prefix ? `${prefix}/${rawName}` : rawName;
  fullName = fullName.replace(/^\.\//, '').replace(/^pi-dist\//, '');

  let type: HeaderMeta['type'];
  if (typeflag === '5') type = 'dir';
  else if (typeflag === '0' || typeflag === '\u0000' || typeflag === '') type = 'file';
  else type = 'skip'; // 硬链接 / 符号链接 / pax 扩展头等：本构建不含，出现则仅跳过其载荷

  return { name: fullName, type, size };
}

function createNullSink(): Sink {
  return { write() {}, end() {} };
}

export function createUstarParser(handlers: UstarHandlers = {}): UstarParser {
  let count = 0;
  let state: 'header' | 'data' | 'padding' = 'header';
  let carry = Buffer.alloc(0);
  let current: { sink: Sink; remaining: number; padding: number } | null = null;
  let finished = false;

  const parser: UstarParser = {
    get count(): number {
      return count;
    },
    push(chunk: Buffer): void {
      if (finished || !chunk || chunk.length === 0) return;

      // carry 只可能是「不足 512 的 header 残片」或 padding 残片（均 < 512 字节），拼接有界。
      const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      let pos = 0;

      while (pos < buf.length) {
        if (state === 'header') {
          if (buf.length - pos < HEADER_SIZE) break;
          const header = buf.subarray(pos, pos + HEADER_SIZE);
          pos += HEADER_SIZE;
          if (header[0] === 0) {
            finished = true; // ustar 结束块（通常两块全 0）：忽略其后所有字节
            return;
          }
          const meta = readHeader(header);
          if (!meta.name) continue;

          if (meta.type === 'dir') {
            handlers.onDirectory?.(meta.name);
            continue;
          }

          if (meta.type === 'file') {
            current = {
              sink: handlers.onFile ? handlers.onFile(meta.name) : createNullSink(),
              remaining: meta.size,
              padding: (HEADER_SIZE - (meta.size % HEADER_SIZE)) % HEADER_SIZE,
            };
            count += 1; // onFile 已为该条目建立数据池；空文件同样计 1
          } else {
            handlers.onSkip?.(meta.name, meta.size);
            current = {
              sink: createNullSink(),
              remaining: meta.size,
              padding: (HEADER_SIZE - (meta.size % HEADER_SIZE)) % HEADER_SIZE,
            };
          }
          state = 'data';
          continue;
        }

        if (state === 'data') {
          const entry = current;
          if (!entry) throw new Error('tar 状态机损坏：data 阶段没有当前条目');
          if (entry.remaining > 0) {
            const n = Math.min(entry.remaining, buf.length - pos);
            if (n > 0) {
              entry.sink.write(buf.subarray(pos, pos + n));
              pos += n;
              entry.remaining -= n;
            }
          }
          if (entry.remaining === 0) {
            entry.sink.end();
            state = 'padding';
            continue;
          }
          break; // 条目数据未到齐，等待下一个 chunk
        }

        // state === 'padding'
        const entry = current;
        if (!entry) throw new Error('tar 状态机损坏：padding 阶段没有当前条目');
        const n = Math.min(entry.padding, buf.length - pos);
        pos += n;
        entry.padding -= n;
        if (entry.padding === 0) {
          current = null;
          state = 'header';
        } else {
          break;
        }
      }

      carry = pos < buf.length ? Buffer.from(buf.subarray(pos)) : Buffer.alloc(0);
    },
    finish(): void {
      if (finished) return;
      if (state !== 'header' || carry.length > 0) {
        throw new Error('tar 数据不完整：流结束时仍有条目未写完');
      }
    },
  };

  return parser;
}

/** 流式解压 ustar tar.gz 到目标目录；返回写出的文件数。 */
export function extractTarGz(archivePath: string, destBase: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const gunzip = createGunzip();
    const input = createReadStream(archivePath);

    const parser = createUstarParser({
      onDirectory(name: string): void {
        mkdirSync(join(destBase, name), { recursive: true });
      },
      onFile(name: string): Sink {
        const destPath = join(destBase, name);
        mkdirSync(dirname(destPath), { recursive: true });
        const fd = openSync(destPath, 'w');
        return {
          write(buf: Buffer): void {
            writeSync(fd, buf);
          },
          end(): void {
            closeSync(fd);
          },
        };
      },
    });

    let settled = false;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    gunzip.on('data', (chunk: Buffer) => {
      try {
        parser.push(chunk);
      } catch (err) {
        fail(err);
      }
    });
    gunzip.on('end', () => {
      if (settled) return;
      try {
        parser.finish();
        settled = true;
        resolve(parser.count);
      } catch (err) {
        fail(err);
      }
    });
    gunzip.on('error', fail);
    input.on('error', fail);
    input.pipe(gunzip);
  });
}

export { readHeader };
