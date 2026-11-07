# Legacy tkz package files

`legacy-tkz-2018.bin` is a gzip-compressed JSON array of VFS paths and Base64-encoded source files. The decompressed package files are verbatim TeX Live runfiles. Their original copyright and license notices remain in the source. TeX Live lists the packages under the LaTeX Project Public License. The historical tkz files also offer the GNU Public License in their headers.

| TeX Live archive | Revision | Catalogue version | Runfiles | Archive SHA-256 |
| --- | ---: | --- | ---: | --- |
| [`tkz-euclide.tar.xz`](https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/2018/tlnet-final/archive/tkz-euclide.tar.xz) (2018 final) | 22830 | 1.16c | 13 | `9fdf93feb1d438c9e790e9021d7ca76959a908dacc69a5fe62c4495dabea4792` |
| [`tkz-base.tar.xz`](https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/2018/tlnet-final/archive/tkz-base.tar.xz) (2018 final) | 48710 | 1.16d | 11 | `91b7129e7ff9100a9935905cc048e93cca3091a6df9c056b3ecd46886f9630e2` |
| [`tkz-fct.tar.xz`](https://ftp.tu-chemnitz.de/pub/tug/historic/systems/texlive/2018/tlnet-final/archive/tkz-fct.tar.xz) (2018 final) | 22831 | 1.16c | 1 | `0a86d040cf9591273e2e9cb72b07069d5fc0d6c9f459bf81cf5e1f6dd6849f2b` |
| `fp.r77682.tar.xz` (pinned TeX Live 2026 tree) | 77682 | 2.1d | 14 | `caa167593809c64e9479ef38f4dbf530b8200e167a3bc998a88196c9fb2abd38` |
| `numprint.r77682.tar.xz` (pinned TeX Live 2026 tree) | 77682 | 1.39 | 3 | `bc60d9959df0044ae6977aed6ee5036cbcd24dd7d20048768489012fe55e89a5` |

The `fp` and `numprint` runfiles are the same versions used in the pinned TeX Live 2026 tree. The bundle includes them so the historical pair can be mounted together without requesting another package solely for the retry. TeX, PGF/TikZ, and other packages remain on the regular runtime.

The tkz-fct runfile is mounted only for the matching historical package load-order diagnostic. The asset is 131,232 bytes. SHA-256 `5a254507f1c0cb638a8a94f592be798b151625025935b9f27c9b94f32421a046`.

For reproduction, extract regular files under `tex/` from the named archives, prepend `/texlive/texmf-dist/` to each path, sort the resulting `[path, Base64(bytes)]` pairs by path, and encode as UTF-8 JSON with compact separators. Compress with gzip at level 9 and modification time zero.
