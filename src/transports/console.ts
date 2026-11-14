/**
 * Console transports: the `stdout` and `stderr` channels (for containers, where the platform
 * collects the streams), and the stderr fallback every sink uses when its own transport fails.
 *
 * v1's `pretty` console format is gone: the `line` format is readable in a terminal and in a file
 * alike (`LOG_FORMAT=pretty` still reads as `line`, with a warning).
 *
 * @module
 */
import type { Batch, Transport, WritableLike } from './types.ts'

/**
 * Write batches to a stream as they are (lines in the channel's format).
 *
 * @param name the transport name, shown in fallback warnings
 *
 * @example
 * streamTransport('stderr', process.stderr)
 */
export function streamTransport(name: string, stream: WritableLike): Transport {
  return {
    name,
    write(batch: Batch): Promise<void> {
      stream.write(batch.text)
      return Promise.resolve()
    },
    close: () => Promise.resolve(),
  }
}

/**
 * The `stdout` channel's transport (default stream: `process.stdout`).
 *
 * @example
 * createPipelineLogger({ transport: stdoutTransport() })
 */
export function stdoutTransport(stream: WritableLike = process.stdout): Transport {
  return streamTransport('stdout', stream)
}

/**
 * The fallback transport, used when a channel's transport fails, and the `stderr` channel. It must
 * be the most boring code in the package: it never rejects and never throws, whatever the stream
 * does (there is nowhere left to report to).
 *
 * @example
 * createPipelineLogger({ transport: fileTransport({ dir }), fallback: stderrTransport() })
 */
export function stderrTransport(stream: WritableLike = process.stderr): Transport {
  return {
    name: 'stderr',
    write(batch: Batch): Promise<void> {
      try {
        stream.write(batch.text)
      } catch {
        // Nowhere left to report to. For a fallback, swallowing is the only safe option.
      }
      return Promise.resolve()
    },
    close: () => Promise.resolve(),
  }
}
