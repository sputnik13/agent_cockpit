/**
 * System font enumeration for the settings font picker. Uses `font-list`
 * (platform font query) and caches the result for the session.
 */
import { getFonts } from 'font-list';

let cache: string[] | null = null;

export async function listSystemFonts(): Promise<string[]> {
  if (cache) return cache;
  try {
    const raw = await getFonts();
    cache = Array.from(
      new Set(raw.map((f) => f.replace(/^"|"$/g, '').trim()).filter((f) => f.length > 0)),
    ).sort((a, b) => a.localeCompare(b));
  } catch {
    cache = [];
  }
  return cache;
}
