import { describe, expect, it } from 'vitest';
import { developmentAppIcon } from './appIcon';

describe('developmentAppIcon', () => {
  it('resolves the transparent packaging source from a development main bundle', () => {
    expect(developmentAppIcon('/project/out/main', true)).toBe('/project/build/icon.png');
  });

  it('leaves icon ownership to the packaged application outside development', () => {
    expect(developmentAppIcon('/project/out/main', false)).toBeUndefined();
  });
});
