import { IconSvg } from './IconSvg';
import { getIconSvg, isTintedIcon, resolveFileIcon } from './fileIcons';

/** The file-type icon for a file's base name (brand logo, or tinted generic). */
export function FileTypeIcon({ name }: { name: string }): JSX.Element {
  const id = resolveFileIcon(name);
  return <IconSvg svg={getIconSvg(id)} tinted={isTintedIcon(id)} />;
}
