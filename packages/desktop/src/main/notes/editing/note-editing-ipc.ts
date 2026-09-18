import { dialog, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { NoteEditor } from './note-editor.js';

export function registerNoteEditingIpc(options: {
  authorized: (event: IpcMainInvokeEvent) => BrowserWindow; generation: () => number;
  editor: () => Promise<NoteEditor>; changed: () => void;
}): void {
  const operations: Record<string, (editor: NoteEditor, input: any, context: () => boolean, event: IpcMainInvokeEvent) => unknown> = {
    'note-edit-list': editor => editor.list(),
    'note-edit-open': (editor, input, context) => editor.open(input, context),
    'note-edit-preview': (editor, input, context) => editor.preview(input, context),
    'note-edit-approve': (editor, input, context) => editor.approve(input, context),
    'note-edit-dismiss': (editor, id, context) => editor.dismiss(id, context),
    'note-edit-review': (editor, id) => editor.review(id),
    'note-edit-undo': (editor, id, context) => editor.undo(id, context),
    'note-edit-close': (editor, id) => editor.close(id),
    'note-edit-forget': (editor, id, context) => editor.forget(id, context),
    'note-edit-choose': (editor, id, context, event) => editor.choose(id, async root => {
      const selected = await dialog.showOpenDialog(options.authorized(event), {title: '연결한 폴더의 Markdown 원본 편집',
        buttonLabel: '원본 열기', defaultPath: root, filters: [{name: 'Markdown', extensions: ['md']}],
        properties: ['openFile', 'dontAddToRecent', 'noResolveAliases']});
      return selected.canceled || selected.filePaths.length !== 1 ? null : selected.filePaths[0]!;
    }, context),
  };
  for (const [channel, work] of Object.entries(operations)) ipcMain.handle('kirian:' + channel, async (event, input) => {
    options.authorized(event); const generation = options.generation();
    const context = () => { options.authorized(event); return generation === options.generation(); };
    try {
      const editor = await options.editor();
      if (!context()) throw new Error('connection_changed');
      const result = await work(editor, input, context, event);
      if (!context()) throw new Error('connection_changed');
      return result;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      // Expose codes only. OS/helper exception messages may contain local data.
      throw new Error(/^(?:note_|write_|action_|approval_|source_|connection_|context_|root_|invalid_|stale_|unknown_|executor_)[a-z_]{1,60}$/.test(code) ? code : 'note_store_unavailable');
    } finally { options.changed(); }
  });
}
