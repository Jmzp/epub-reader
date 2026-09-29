import { strToU8, zipSync } from 'fflate';

/** Builds a small EPUB in memory so tests don't depend on copyrighted books. */
export function makeEpub(version: 2 | 3): Uint8Array {
  const chapter = (n: number) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter ${n}</title>
<link rel="stylesheet" type="text/css" href="../Styles/book.css"/></head>
<body><h1 id="c${n}">Chapter ${n}</h1><p>Text of chapter ${n}.</p><img src="../Images/pixel.png" alt=""/></body></html>`;

  const manifestExtra =
    version === 3
      ? `<item id="nav" href="Text/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="Images/cover.png" media-type="image/png" properties="cover-image"/>`
      : `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="cover" href="Images/cover.png" media-type="image/png"/>`;

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${version}.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:test-${version}</dc:identifier>
    <dc:title>Test Book ${version}</dc:title>
    <dc:creator>Jane Author</dc:creator>
    <dc:language>es</dc:language>
    ${version === 2 ? '<meta name="cover" content="cover"/>' : ''}
  </metadata>
  <manifest>
    <item id="c1" href="Text/chapter%201.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="Text/chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="Styles/book.css" media-type="text/css"/>
    <item id="px" href="Images/pixel.png" media-type="image/png"/>
    ${manifestExtra}
  </manifest>
  <spine${version === 2 ? ' toc="ncx"' : ''}>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>`;

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><navMap>
  <navPoint id="n1" playOrder="1"><navLabel><text>Chapter 1</text></navLabel><content src="Text/chapter%201.xhtml#c1"/>
    <navPoint id="n1a" playOrder="2"><navLabel><text>Section 1.1</text></navLabel><content src="Text/chapter%201.xhtml"/></navPoint>
  </navPoint>
  <navPoint id="n2" playOrder="3"><navLabel><text>Chapter 2</text></navLabel><content src="Text/chapter2.xhtml#c2"/></navPoint>
</navMap></ncx>`;

  const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Nav</title></head><body>
<nav epub:type="toc"><ol>
  <li><a href="chapter%201.xhtml#c1">Chapter 1</a><ol><li><a href="chapter%201.xhtml">Section 1.1</a></li></ol></li>
  <li><a href="chapter2.xhtml#c2">Chapter 2</a></li>
</ol></nav></body></html>`;

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/Text/chapter 1.xhtml': strToU8(chapter(1)),
    'OEBPS/Text/chapter2.xhtml': strToU8(chapter(2)),
    'OEBPS/Styles/book.css': strToU8('body { margin: 0 5pt } h1 { background: url(../Images/pixel.png) }'),
    'OEBPS/Images/pixel.png': png,
    'OEBPS/Images/cover.png': png,
  };
  if (version === 2) files['OEBPS/toc.ncx'] = strToU8(ncx);
  else files['OEBPS/Text/nav.xhtml'] = strToU8(nav);
  return zipSync(files);
}
