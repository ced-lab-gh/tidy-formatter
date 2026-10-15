// Vue SFC integration suite (ADD-15): runs INSIDE a real VS Code Electron host.
// Uses untitled documents with an explicit languageId and queries the registered
// provider directly via executeFormatDocumentProvider. The hermetic host ships no
// Vue extension, and VS Code does NOT accept an unregistered languageId (it falls
// back to plaintext), so test/integration/vue-language-stub declares the id.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { activateExtension } from './helpers';
import { VUE_BASIC } from '../fixtures/vueFixtures';

async function openVueDocument(content: string): Promise<vscode.TextDocument> {
  const document = await vscode.workspace.openTextDocument({ language: 'vue', content });
  // Without this, a missing language stub would turn every "zero edits" test
  // below into a vacuous pass on a plaintext document.
  assert.equal(document.languageId, 'vue', 'the host must know the vue languageId');
  return document;
}

async function formatEdits(
  document: vscode.TextDocument
): Promise<vscode.TextEdit[] | undefined> {
  return vscode.commands.executeCommand<vscode.TextEdit[]>(
    'vscode.executeFormatDocumentProvider',
    document.uri,
    { tabSize: 2, insertSpaces: true }
  );
}

async function applyEdits(
  document: vscode.TextDocument,
  edits: readonly vscode.TextEdit[]
): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  for (const textEdit of edits) {
    edit.replace(document.uri, textEdit.range, textEdit.newText);
  }
  await vscode.workspace.applyEdit(edit);
}

describe('VUE integration : SFC formatting in a real VS Code host (ADD-15)', function () {
  this.timeout(60_000);

  before(async () => {
    await activateExtension();
  });

  it('(a) formats template and style, keeps the script block byte-identical', async () => {
    const document = await openVueDocument(VUE_BASIC);
    const edits = await formatEdits(document);
    assert.ok(edits && edits.length > 0, 'the vue provider must return edits');
    await applyEdits(document, edits!);
    const formatted = document.getText();
    assert.notEqual(formatted, VUE_BASIC, 'the document must actually change');
    assert.ok(
      formatted.includes(
        '<script setup lang="ts">\nconst count = props?.count ?? 0;\n' +
          'function onClick(){emit("pick",count)}\n</script>'
      ),
      'the whole script block must survive byte-for-byte'
    );
    // Host-level idempotence: a second format is a no-op.
    const again = await formatEdits(document);
    assert.ok(!again || again.length === 0, 'second format must be a no-op');
  });

  it('(b) tidy.vue.enable=false disables the provider (zero edits)', async () => {
    const config = vscode.workspace.getConfiguration('tidy');
    await config.update('vue.enable', false, vscode.ConfigurationTarget.Global);
    try {
      const document = await openVueDocument(VUE_BASIC);
      const edits = await formatEdits(document);
      assert.ok(!edits || edits.length === 0, 'disabled language must yield no edits');
    } finally {
      await config.update('vue.enable', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  it('(c) formatting a vue document never touches editor.defaultFormatter or formatOnSave (ARCH-02)', async () => {
    const editorConfig = vscode.workspace.getConfiguration('editor');
    const beforeDefault = editorConfig.inspect('defaultFormatter');
    const beforeOnSave = editorConfig.inspect('formatOnSave');
    const document = await openVueDocument(VUE_BASIC);
    await formatEdits(document);
    const afterDefault = vscode.workspace.getConfiguration('editor').inspect('defaultFormatter');
    const afterOnSave = vscode.workspace.getConfiguration('editor').inspect('formatOnSave');
    assert.deepEqual(afterDefault?.globalValue, beforeDefault?.globalValue);
    assert.deepEqual(afterDefault?.workspaceValue, beforeDefault?.workspaceValue);
    assert.deepEqual(afterOnSave?.globalValue, beforeOnSave?.globalValue);
    assert.deepEqual(afterOnSave?.workspaceValue, beforeOnSave?.workspaceValue);
  });

  it('(d) a pug template is a clean no-op through the full host path', async () => {
    const pug = '<template lang="pug">\ndiv.card\n</template>\n';
    const document = await openVueDocument(pug);
    const edits = await formatEdits(document);
    assert.ok(!edits || edits.length === 0, 'pug SFC must be a clean no-op');
  });
});
