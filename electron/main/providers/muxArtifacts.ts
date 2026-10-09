import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type MuxArtifact = { os: string; arch: string; filename: string; sha256: string };
export type MuxArtifactManifest = {
  version: string;
  sourceHash?: string;
  binaries: MuxArtifact[];
};

export class MuxArtifactError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'MuxArtifactError';
  }
}

const ARTIFACT_FILENAME = /^cockpit-mux-[0-9A-Za-z._-]+-(darwin|linux)-(amd64|arm64)$/;

export function isMuxArtifactFilename(filename: string): boolean {
  return ARTIFACT_FILENAME.test(filename);
}

/** Release artifacts are selected from the newest complete manifest, never by filename alone. */
export async function loadMuxArtifactManifest(directory: string): Promise<MuxArtifactManifest> {
  let manifestPath: string;
  try {
    const versioned = (await readdir(directory))
      .map((name) => ({ name, version: /^manifest-(\d+)\.(\d+)\.(\d+)\.json$/.exec(name) }))
      .filter(
        (entry): entry is { name: string; version: RegExpExecArray } => entry.version !== null,
      )
      .sort((left, right) => {
        for (let index = 1; index <= 3; index += 1) {
          const delta = Number(right.version[index]) - Number(left.version[index]);
          if (delta !== 0) return delta;
        }
        return 0;
      });
    manifestPath = join(directory, versioned[0]?.name ?? 'manifest.json');
  } catch (cause) {
    throw new MuxArtifactError(`read mux artifact directory: ${directory}`, cause);
  }

  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as MuxArtifactManifest;
    if (!Array.isArray(manifest.binaries)) {
      throw new MuxArtifactError(`invalid mux artifact manifest: ${manifestPath}`);
    }
    return manifest;
  } catch (cause) {
    if (cause instanceof MuxArtifactError) throw cause;
    throw new MuxArtifactError(`read mux artifact manifest: ${manifestPath}`, cause);
  }
}

export function selectMuxArtifact(
  manifest: MuxArtifactManifest,
  os: string,
  arch: string,
): MuxArtifact | undefined {
  return manifest.binaries.find((entry) => entry.os === os && entry.arch === arch);
}

/** Verify a manifest-declared SHA-256 before local execution or remote upload. */
export async function verifyMuxArtifact(path: string, expectedSha256: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) {
    throw new MuxArtifactError(`invalid mux artifact checksum: ${path}`);
  }
  try {
    const actualSha256 = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
    if (actualSha256 !== expectedSha256.toLowerCase()) {
      throw new MuxArtifactError(`mux artifact checksum mismatch: ${path}`);
    }
  } catch (cause) {
    if (cause instanceof MuxArtifactError) throw cause;
    throw new MuxArtifactError(`read mux artifact checksum: ${path}`, cause);
  }
}
