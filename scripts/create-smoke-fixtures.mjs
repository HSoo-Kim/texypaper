import { mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const tag = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([tag, data])));
  return Buffer.concat([size, tag, data, crc]);
}
function raster(seed) {
  const width = 384, height = 256, raw = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    raw[offset] = (x + seed * 17) % 256;
    raw[offset + 1] = (y + seed * 29) % 256;
    raw[offset + 2] = (Math.floor(x / 16) * Math.floor(y / 16) + seed * 31) % 256;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function referencePdf() {
  const content = 'BT /F1 16 Tf 48 740 Td (TexyPaper reference PDF only. No TeX editing authority.) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
  ];
  let pdf = '%PDF-1.4\n', offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}
async function treeBytes(root) {
  let bytes = 0, files = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) { const child = await treeBytes(target); bytes += child.bytes; files += child.files; }
    else { bytes += (await stat(target)).size; files++; }
  }
  return { bytes, files };
}
export async function createSmokeFixtures({ outputDir, stress = true }) {
  if (!outputDir) throw new Error('An explicit outputDir is required for isolated synthetic fixtures.');
  const output = path.resolve(outputDir);
  // Exclusive sentinel prevents accidentally treating a real paper directory as a fixture.
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length !== 0) throw new Error('Fixture output must be new or empty; refusing to overwrite existing files or a user paper.');
  await writeFile(path.join(output, '.texypaper-smoke-fixture'), 'TexyPaper synthetic fixture version 1\n', { flag: 'wx' });
  const root = path.join(output, 'paper fixture with spaces');
  const secondRoot = path.join(output, 'second isolated project');
  for (const directory of ['sections', 'figures', 'code', 'results', 'paper-direct', 'ancestor/deep/paper', 'pdf-only', 'node_modules/ignored-paper', '.texypaper']) await mkdir(path.join(root, directory), { recursive: true });
  await mkdir(secondRoot, { recursive: true });
  const main = String.raw`\documentclass[10pt]{article}
\usepackage[a4paper,margin=24mm]{geometry}
\usepackage{graphicx}
\usepackage[T1]{fontenc}
\title{TexyPaper deterministic release smoke}
\author{Synthetic fixture}
\date{}
\begin{document}
` + Array.from({ length: 30 }, (_, index) => `\\input{sections/page-${String(index + 1).padStart(2, '0')}}\n${index < 29 ? '\\newpage\n' : ''}`).join('') + '\\end{document}\n';
  await writeFile(path.join(root, 'main.tex'), main);
  let sourceBytes = Buffer.byteLength(main);
  for (let index = 1; index <= 30; index++) {
    const prose = `TexyPaper page ${index}: measured evidence supports careful scientific writing. The stable literal sentence identifies source mapping without guessing.\nA second source line continues the paragraph across an ordinary source wrap.\n\n`;
    let body = `% !TeX root = ../main.tex\n\\section*{Synthetic page ${index}}\n${prose}`;
    body += `Repeated prose must never authorize a guessed replacement.\n\nRepeated prose must never authorize a guessed replacement.\n\n`;
    body += String.raw`A formatted \emph{conservative formatting interval} remains distinct from mathematics $x^2+y^2$ and a citation \cite{fixture2026}. Office affinity offers ligature evidence; dis\-cretionary is deliberately hyphenated.
`;
    if (index <= 10) body += `\n\\begin{center}\\includegraphics[width=65mm,height=35mm]{figures/figure-${index}.png}\\end{center}\n`;
    if (index === 30) body += '\\bibliographystyle{plain}\n\\bibliography{references}\n';
    // Comments add deterministic real source bytes without changing page count or typesetting cost.
    while (Buffer.byteLength(body) < 6700) body += `% fixture padding ${String(index).padStart(2, '0')} abcdefghijklmnopqrstuvwxyz 0123456789 reproducible source bytes\n`;
    await writeFile(path.join(root, 'sections', `page-${String(index).padStart(2, '0')}.tex`), body);
    sourceBytes += Buffer.byteLength(body);
  }
  for (let index = 1; index <= 10; index++) await writeFile(path.join(root, 'figures', `figure-${index}.png`), raster(index));
  const bib = '@article{fixture2026, author={Synthetic Author}, title={Deterministic evidence}, year={2026}}\n';
  await writeFile(path.join(root, 'references.bib'), bib); sourceBytes += Buffer.byteLength(bib);
  await writeFile(path.join(root, 'code', 'analysis.py'), 'observations = [0.81, 0.83, 0.85]\nmean_accuracy = sum(observations) / len(observations)\nprint(f"mean_accuracy={mean_accuracy:.2f}")\n');
  await writeFile(path.join(root, 'results', 'metrics.csv'), 'metric,value,n\nmean_accuracy,0.83,3\n');
  await writeFile(path.join(root, 'paper-direct', 'evidence.bib'), bib);
  await writeFile(path.join(root, 'ancestor', 'deep', 'paper', 'deep.tex'), '% Deep filename classification evidence only.\n');
  await writeFile(path.join(root, 'node_modules', 'ignored-paper', 'ignored.tex'), '% Excluded by default.\n');
  await writeFile(path.join(root, 'unicode-crlf.tex'), Buffer.concat([Buffer.from([0xef,0xbb,0xbf]), Buffer.from('% 한글 😀 e\u0301\r\nUTF8 BOM and CRLF must survive a save.\r\n')]));
  await writeFile(path.join(root, 'unsupported-encoding.txt'), Buffer.from([0xff,0xfe,0x48,0,0x69,0]));
  await writeFile(path.join(root, 'long-' + 'filename-'.repeat(18) + '.txt'), 'Long filename accessibility fixture.\n');
  await writeFile(path.join(root, 'large-readonly.tex'), '% Explicit large-file notice required.\n' + '% bounded large source line\n'.repeat(170000));
  await writeFile(path.join(root, 'other-paper.tex'), '\\documentclass{article}\n\\begin{document}Second root candidate requires explicit choice.\\end{document}\n');
  await writeFile(path.join(secondRoot, 'main.tex'), '\\documentclass{article}\n\\begin{document}Second workspace epoch isolation.\\end{document}\n');
  await writeFile(path.join(root, 'busy.tex'), '\\documentclass{article}\n\\begin{document}\\newcount\\smokecounter\\smokecounter=0\\loop\\advance\\smokecounter by1\\ifnum\\smokecounter<1000000000\\repeat Busy build cancellation.\\end{document}\n');
  await writeFile(path.join(root, 'pdf-only', 'reference.pdf'), referencePdf());
  const mappingPairRoot = path.join(output, 'mapping-pair');
  const mappingMain = '\\documentclass{article}\n\\begin{document}\nThe first paragraph is literal prose for a real SyncTeX comparison.\n\nThe middle paragraph has a unique deterministic navigation sentence.\n\nUnicode mapping retains source identity without a basename shortcut.\n\n\\input{section}\n\nThe final paragraph is literal prose for last-line neighborhood checks.\n\\end{document}\n';
  const mappingSection = 'Included source evidence is byte-identical in the ASCII and Unicode subtrees.\n\nConservative geometry and source revisions determine every editable interval.\n';
  for (const directory of ['paper-ASCII', '한국 논문']) {
    const target = path.join(mappingPairRoot, directory); await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'main.tex'), mappingMain); await writeFile(path.join(target, 'section.tex'), mappingSection);
  }
  if (stress) {
    const stressRoot = path.join(root, 'stress-tree'); await mkdir(stressRoot);
    for (let directory = 0; directory < 100; directory++) {
      const folder = path.join(stressRoot, `directory-${String(directory).padStart(3, '0')}`); await mkdir(folder);
      // 100 directories + 19,900 files = exactly 20,000 entries below stress-tree.
      await Promise.all(Array.from({ length: 199 }, (_, index) => writeFile(path.join(folder, `entry-${String(index).padStart(3, '0')}${directory === 99 && index === 198 ? '.bib' : '.txt'}`), '')));
    }
  }
  const manifest = { version: 1, synthetic: true, root, secondRoot, mappingPairRoot, main: 'main.tex', expectedPages: 30, sourceBytes, imageCount: 10, maxPdfBytes: 10 * 1024 * 1024, stressEntries: stress ? 20000 : 0, evidence: { metric: 'mean_accuracy', value: 0.83, count: 3 }, files: { prose: 'sections/page-01.tex', unicode: 'unicode-crlf.tex', bibliography: 'references.bib', analysis: 'code/analysis.py', metrics: 'results/metrics.csv' }, tree: await treeBytes(root), fixtureDigest: createHash('sha256').update(main + bib).digest('hex') };
  await writeFile(path.join(output, 'fixtures.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { parseArgs } = await import('./smoke-support.mjs');
  try { const args = parseArgs(); const result = await createSmokeFixtures({ outputDir: args.output, stress: args.stress !== 'false' }); console.log(JSON.stringify(result)); }
  catch (error) { console.error(error.stack ?? String(error)); process.exitCode = 1; }
}
