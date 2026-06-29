// DEMO (driven entirely by the agent, no human action): format the real messy
// sample files THROUGH the extension inside a real VS Code Electron host, then
// write the results to samples/out/ so they can be inspected without anyone
// touching the editor. This is "the agent runs Tidy in real VS Code for you".
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  activateExtension,
  ensureTidyDefaultFormatter,
  openFixture,
  runFormatDocument
} from './helpers';

// out/test/integration/demo-samples.test.js -> project root is three levels up.
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT_DIR = path.join(PROJECT_ROOT, 'samples', 'out');

const MESSY_CSS =
  '.card{display:flex;padding:8px;color:red}\n' +
  '   #main   >   .item:nth-child(2n){margin:calc(100% - 20px);background:blue}\n' +
  'a:hover{text-decoration:underline}    .footer    {   gap : 12px  }\n';

const MESSY_TSX =
  'import {useState,useEffect} from "react"\n' +
  'type Props={title:string,count?:number}\n' +
  'export function Widget({title,count=0}:Props){\n' +
  'const [n,setN]=useState(count);useEffect(()=>{console.log(n?.toString()??"none")},[n])\n' +
  'return <div className="card"   onClick={()=>setN(n+1)}><h1>{title}</h1><span>{n}</span></div>\n' +
  '}\n';

describe('DEMO — Tidy formats the real sample files in a real VS Code host', function () {
  this.timeout(30000);

  const LANGS = ['css', 'typescriptreact'];

  let restoreFormatter: (() => Promise<void>) | undefined;

  before(async () => {
    await activateExtension();
    // Set Tidy as the PER-LANGUAGE default formatter (exactly what a user does via
    // "Format Document With… → Configure Default Formatter… → Tidy") AND wait until
    // it is actually resolvable, so the first format on a cold host is never a
    // race-induced no-op (see ensureTidyDefaultFormatter for the rationale).
    restoreFormatter = await ensureTidyDefaultFormatter(LANGS);
    fs.mkdirSync(OUT_DIR, { recursive: true });
  });

  after(async () => {
    if (restoreFormatter) {
      await restoreFormatter();
    }
  });

  const cases = [
    { name: 'messy.css', content: MESSY_CSS, lang: 'css' },
    { name: 'messy.tsx', content: MESSY_TSX, lang: 'typescriptreact' }
  ];

  for (const c of cases) {
    it(`formats ${c.name} via the extension and writes samples/out/${c.name}`, async () => {
      const doc = await openFixture(`demo/${c.name}`, c.content, c.lang);
      await vscode.window.showTextDocument(doc);
      await runFormatDocument();
      const formatted = doc.getText();

      fs.writeFileSync(path.join(OUT_DIR, c.name), formatted, 'utf8');
      // eslint-disable-next-line no-console
      console.log(`\n===== ${c.name} formatted by Tidy in real VS Code =====\n${formatted}\n=====`);

      // Soft proof it actually reformatted (no hard fail on env quirks).
      assert.notEqual(formatted, c.content, `${c.name} should have been reformatted`);
    });
  }
});
