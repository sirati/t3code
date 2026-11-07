import { useComposerDraftStore, type ComposerThreadTarget } from "../composerDraftStore";
import { reviewCommentContextId, terminalContextReference } from "./composerContextRecords";
import { reconcileAttachmentContextReferences } from "../components/chat/composerContextUndo";

export function captureComposerDictationDraft(
  target: ComposerThreadTarget,
  submit?: (prompt: string) => void,
) {
  return {
    read: () => useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "",
    write: (value: string, shouldSubmit: boolean, contextIds: string[]) => {
      const store = useComposerDraftStore.getState();
      const draft = store.getComposerDraft(target);
      const referenced = new Set(contextIds);
      store.setPrompt(target, value);
      if (draft) {
        store.setTerminalContexts(
          target,
          draft.terminalContexts.filter((context) =>
            referenced.has(terminalContextReference(context).contextId),
          ),
        );
        store.setThreadContexts(
          target,
          draft.threadContexts.filter((context) => referenced.has(context.contextId)),
        );
        store.setEnvironmentContexts(
          target,
          draft.environmentContexts.filter((context) => referenced.has(context.contextId)),
        );
        for (const comment of draft.reviewComments) {
          if (!referenced.has(reviewCommentContextId(comment.id)))
            store.removeReviewComment(target, comment.id);
        }
        const changes = reconcileAttachmentContextReferences({
          referencedContextIds: referenced,
          ...draft,
          retained: { files: new Map(), previewAnnotations: new Map() },
        });
        for (const id of changes.filesToRemove) store.removeFile(target, id);
        for (const id of changes.annotationIdsToRemove) store.removePreviewAnnotation(target, id);
      }
      if (shouldSubmit) submit?.(value);
      return true;
    },
  };
}
