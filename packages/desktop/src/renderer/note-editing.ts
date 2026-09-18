import { ref, watch, type Ref } from 'vue';
import type { DesktopBridge } from '../shared/bridge.js';
import type { NoteEditApproval, NoteEditDocument, NoteEditReview, NoteEditSummary } from '../shared/note-editing.js';

export function useNoteEditing(bridge: DesktopBridge | undefined, available: Ref<boolean>, generation: Ref<number>) {
  const document = ref<NoteEditDocument | null>(null), review = ref<NoteEditReview | null>(null);
  const history = ref<NoteEditSummary[]>([]), busy = ref(false), error = ref<string | null>(null);
  let epoch = 0;
  function close() {
    if (document.value) void bridge?.closeNoteFile(document.value.documentId).catch(() => {});
    document.value = null; review.value = null; error.value = null;
  }
  async function refresh() {
    if (!bridge || !available.value) return;
    const current = epoch;
    try { const result = await bridge.listNoteEdits(); if (current === epoch) history.value = result; }
    catch { if (current === epoch) error.value = 'note_store_unavailable'; }
  }
  watch([available, generation], () => {
    epoch++; close(); history.value = []; busy.value = false;
    if (available.value) void refresh();
  }, {immediate: true});
  async function run<T>(operation: () => Promise<T>, accept: (result: T) => void) {
    if (!bridge || !available.value || busy.value) return;
    const current = epoch; busy.value = true; error.value = null;
    try { const result = await operation(); if (current === epoch) accept(result); }
    catch (reason) {
      if (current === epoch) error.value = String(reason).match(/\b(?:note_|write_|action_|approval_|source_|connection_|context_|root_|invalid_|stale_|unknown_|executor_)[a-z_]+\b/)?.[0] ?? 'note_store_unavailable';
    } finally { if (current === epoch) { busy.value = false; await refresh(); } }
  }
  return {document, review, history, busy, error, close, refresh,
    open: (input: {folderId: string; path: string}) => run(() => bridge!.openNoteFile(input), value => { close(); document.value = value; }),
    choose: (id: string) => run(() => bridge!.chooseNoteFile(id), value => { if (value) { close(); document.value = value; } }),
    preview: (text: string) => { const id = document.value?.documentId; return id ? run(() => bridge!.previewNoteEdit({documentId: id, text}), value => { review.value = value; }) : undefined; },
    approve: (input: NoteEditApproval) => run(() => bridge!.approveNoteEdit(input), value => { close(); review.value = value; }),
    dismiss: (id: string) => run(() => bridge!.dismissNoteEdit(id), () => { close(); }),
    forget: (id: string) => run(() => bridge!.forgetNoteEdit(id), () => { close(); }),
    showReview: (id: string) => run(() => bridge!.reviewNoteEdit(id), value => { close(); review.value = value; }),
    undo: (id: string) => run(() => bridge!.previewNoteUndo(id), value => { close(); review.value = value; }),
  };
}
