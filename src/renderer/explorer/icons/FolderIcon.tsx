import { IconSvg } from './IconSvg';
import { getIconSvg } from './fileIcons';

/** The folder icon, open or closed; always theme-tinted. */
export function FolderIcon({ open }: { open: boolean }): JSX.Element {
  return <IconSvg svg={getIconSvg(open ? 'folder-open' : 'folder')} tinted />;
}
