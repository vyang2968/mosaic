"use client";

import Image from "next/image";
import { useState } from "react";
import { useParams } from "next/navigation";
import { useBoards } from "@/lib/boards/useBoards";
import type { Board } from "@/types/board";
import { LAYOUT_SLOTS } from "@/lib/boards/layoutSlots";
import { BoardSlot } from "./BoardSlot";
import { ProjectPin } from "./ProjectPin";
import { PlaceholderPin } from "./PlaceholderPin";
import { CreateBoardModal } from "./CreateBoardModal";
import { DeleteBoardDialog } from "./DeleteBoardDialog";

const INVITE_PROMPTS = ["your room", "an outfit", "a trip", "a gift"];

export function BulletinBoard() {
  const { boards, loading, error, refresh } = useBoards();
  const params = useParams<{ boardId?: string }>();
  const selectedId = params?.boardId;

  const [showCreate, setShowCreate] = useState(false);
  const [createDefaultName, setCreateDefaultName] = useState("");
  const [boardToDelete, setBoardToDelete] = useState<Board | null>(null);

  function openCreate(defaultName = "") {
    setCreateDefaultName(defaultName);
    setShowCreate(true);
  }

  return (
    <div className="relative mx-auto max-w-7xl px-6 py-10 sm:px-10">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <Image src="/logo-mark.png" alt="" width={295} height={356} priority className="h-9 w-auto sm:h-11" />
            <Image src="/logo-word.png" alt="mosaic" width={832} height={359} priority className="h-9 w-auto sm:h-11" />
          </div>
          <p className="mt-1 text-sm text-stone-500">
            your worlds, all in one place
          </p>
        </div>
      </div>

      <div className="rounded-[28px] bg-[#fbfaf6] p-3 shadow-[0_30px_60px_-15px_rgba(60,40,20,0.35)] sm:p-5">
        <div className="cork-texture relative min-h-[640px] overflow-hidden rounded-[18px] sm:min-h-[760px]">
          {error && (
            <div className="absolute inset-x-6 top-6 z-10 rounded-lg bg-white p-4 text-sm text-red-800 shadow-md">
              {error} <button className="ml-3 underline" onClick={() => void refresh()}>retry</button>
            </div>
          )}
          {loading ? (
            <p className="absolute inset-0 flex items-center justify-center text-[#f6efe1]/90">
              loading your boards…
            </p>
          ) : (
            <div className="flex flex-col items-center gap-6 p-6 sm:p-10 lg:block lg:h-full lg:p-0">
              {boards.length === 0
                ? INVITE_PROMPTS.map((label, i) => {
                    const slot = LAYOUT_SLOTS[i % LAYOUT_SLOTS.length];
                    return (
                      <BoardSlot key={label} slot={slot}>
                        <PlaceholderPin
                          label={label}
                          rotate={slot.rotate}
                          onClick={() => openCreate(label)}
                        />
                      </BoardSlot>
                    );
                  })
                : (
                    <>
                      {boards.map((board, i) => {
                        const slot = LAYOUT_SLOTS[i % LAYOUT_SLOTS.length];
                        // While this board is "selected" (we're on
                        // /boards/[id]), leave its spot empty — BoardDetail
                        // renders the matching layoutId so Framer Motion can
                        // morph the pin into the full panel.
                        if (board.id === selectedId) {
                          return (
                            <BoardSlot key={board.id} slot={slot}>
                              <div className="w-64" />
                            </BoardSlot>
                          );
                        }
                        return (
                          <BoardSlot key={board.id} slot={slot}>
                            <ProjectPin board={board} rotate={slot.rotate} onRequestDelete={setBoardToDelete} />
                          </BoardSlot>
                        );
                      })}
                      <BoardSlot
                        slot={LAYOUT_SLOTS[boards.length % LAYOUT_SLOTS.length]}
                      >
                        <PlaceholderPin
                          label="add another vibe"
                          rotate={LAYOUT_SLOTS[boards.length % LAYOUT_SLOTS.length].rotate}
                          onClick={() => openCreate()}
                        />
                      </BoardSlot>
                    </>
                  )}
            </div>
          )}
        </div>
      </div>

      {showCreate && (
        <CreateBoardModal
          initialName={createDefaultName}
          onClose={() => setShowCreate(false)}
        />
      )}
      {boardToDelete && (
        <DeleteBoardDialog board={boardToDelete} onClose={() => setBoardToDelete(null)} />
      )}
    </div>
  );
}
