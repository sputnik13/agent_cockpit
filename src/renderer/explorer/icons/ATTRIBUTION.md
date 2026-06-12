# Explorer file icons — attribution

The SVG icons under `svg/` are a curated subset vendored from the
**Material Icon Theme** (the VS Code icon theme by Material Extensions),
licensed under the MIT License.

- Source: https://github.com/material-extensions/vscode-material-icon-theme
- Package: `material-icon-theme`
- Version copied from: `5.35.0`

Only the icons the Explorer actually renders are committed here (file-type
brand logos plus folder/generic glyphs), not the full upstream set.

## Local modifications

The three theme-tinted glyphs — `folder.svg`, `folder-open.svg`, and the
generic `file.svg` — have their fixed `fill="#90a4ae"` replaced with
`fill="currentColor"` so the renderer can tint them with the app theme's
`--color-dim` token. The brand file-type logos are committed verbatim and
keep their published colors.

## License

```
The MIT License (MIT)
Copyright (c) 2025 Material Extensions

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
