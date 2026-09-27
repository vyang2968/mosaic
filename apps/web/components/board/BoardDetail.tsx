"use client";

import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useBoards } from "@/lib/boards/useBoards";
import { BoardCommerce } from "./BoardCommerce";

export function BoardDetail({ boardId }: { boardId: string }) {
  const { boards, loading, addImages, analyzeBoard } = useBoards();
  const router = useRouter();
  const [analysisState, setAnalysisState] = useState<"idle" | "running">("idle");
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const attemptedAnalysis = useRef<string | null>(null);
  const board = boards.find((item) => item.id === boardId);

  const runAnalysis = useCallback(async () => {
    setAnalysisState("running");
    setAnalysisError(null);
    try {
      await analyzeBoard(boardId);
    } catch (cause) {
      setAnalysisError(cause instanceof Error ? cause.message : "Could not analyze this board");
    } finally {
      setAnalysisState("idle");
    }
  }, [analyzeBoard, boardId]);

  useEffect(() => {
    if (!loading && board && board.images.length > 0 && !board.vibe && attemptedAnalysis.current !== boardId) {
      attemptedAnalysis.current = boardId;
      void runAnalysis();
    }
  }, [board, boardId, loading, runAnalysis]);

  async function handleUpload(files: FileList | null) {
    if (!files?.length) return;
    setActionError(null);
    try {
      await addImages(boardId, Array.from(files));
      await runAnalysis();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "Could not upload images");
    }
  }

  if (loading) return null;

  if (!board) {
    return (
      <Overlay onClose={() => router.push("/boards")}>
        <p className="rounded-2xl bg-[#faf6ee] p-6 text-stone-600 shadow-2xl">
          This board could not be found.
        </p>
      </Overlay>
    );
  }

  return (
    <Overlay onClose={() => router.push("/boards")}>
      <motion.div
        layoutId={`pin-${board.id}`}
        transition={{ type: "spring", stiffness: 260, damping: 28 }}
        className="mx-auto w-full max-w-6xl rounded-2xl bg-[#faf6ee] p-6 shadow-2xl sm:p-10"
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {board.images.map((img) => (
            <div key={img.id} className={`aspect-square overflow-hidden rounded-md border border-white bg-stone-200 shadow-sm ${analysisState === "running" ? "animate-pulse" : ""}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.image_url} alt="Inspiration" className="h-full w-full object-cover" />
            </div>
          ))}
          <label className="flex aspect-square cursor-pointer flex-col items-center justify-center gap-1.5 rounded-md border-2 border-dashed border-stone-300 p-2 text-center text-xs text-stone-600 transition-colors hover:border-stone-400 hover:bg-stone-50">
            <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-full border border-stone-300 text-base leading-none text-stone-500">+</span>
            <span>Add more images</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="sr-only"
              onChange={(event) => { void handleUpload(event.target.files); event.target.value = ""; }}
            />
          </label>
        </div>
        {actionError && <p role="alert" className="mt-2 text-sm text-red-700">{actionError}</p>}

        <h1 className="mt-6 font-heading text-3xl text-stone-900">{board.name}</h1>

        {board.vibe ? (
          <div className="mt-3">
            <p className="font-heading text-lg text-stone-700">{board.vibe.name}</p>
            {board.vibe.description && <p className="mt-1 text-sm text-stone-500">{board.vibe.description}</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              {[...board.vibe.colors, ...board.vibe.materials, ...board.vibe.qualities].map((tag) => (
                <span key={tag} className="rounded-full bg-[#f0e4c8] px-3 py-1 text-xs text-stone-700">{tag}</span>
              ))}
            </div>
          </div>
        ) : analysisState === "running" ? (
          <div role="status" aria-live="polite" className="mt-3 flex items-center gap-3 text-sm text-stone-700">
            <Spinner />
            <span>Analyzing your images…</span>
          </div>
        ) : (
          <p className="mt-3 text-sm text-stone-600">No vibe profile yet.</p>
        )}

        {analysisError && (
          <p role="alert" className="mt-3 text-sm text-red-700">
            {analysisError} <button className="underline" onClick={() => void runAnalysis()}>Retry analysis</button>
          </p>
        )}

        {board.vibe ? (
          <BoardCommerce boardId={boardId} vibeName={board.vibe.name} />
        ) : (
          // Chat/cart need a vibe profile to search against.
          <div className="mt-8 rounded-2xl border border-dashed border-stone-300 bg-white/50 p-6 text-center text-sm text-stone-600">
            {analysisState === "running"
              ? "Shopping unlocks once we've analyzed your board's vibe — hang tight."
              : "Upload images to unlock shopping."}
          </div>
        )}
      </motion.div>
    </Overlay>
  );
}

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin text-stone-500" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

function Overlay({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/60 p-4 py-10 sm:p-10">
      <button onClick={onClose} aria-label="Close board" className="fixed right-6 top-6 z-50 flex h-9 w-9 items-center justify-center rounded-full bg-white text-stone-700 shadow-md">✕</button>
      {children}
    </motion.div>
  );
}
