import { DND_BLOCK_TYPE, encodeBlockPayload, setActiveDragBlock } from "../canvas/dnd";
import type { BlockMetadata } from "../model/types";
import { BlockTile } from "./BlockTile";

interface SidebarItemProps {
  entry: BlockMetadata;
  onInsert: (entry: BlockMetadata) => void;
  onOpenVariants?: (entry: BlockMetadata) => void;
  /**
   * Shown dimmed after the label, for an entry whose label another entry also
   * answers to — see `duplicate-labels.ts`. Two rows both reading "Step" is
   * not a choice a reader can make.
   */
  qualifier?: string;
}

export function SidebarItem({ entry, onInsert, onOpenVariants, qualifier }: SidebarItemProps) {
  const handleDragStart = (event: React.DragEvent<HTMLButtonElement>) => {
    setActiveDragBlock(entry.name, entry.label);
    event.dataTransfer.setData(DND_BLOCK_TYPE, encodeBlockPayload(entry.name));
    event.dataTransfer.setData("text/plain", entry.name);
    event.dataTransfer.effectAllowed = "copy";

    const dragImage = document.createElement("span");
    dragImage.textContent = entry.label;
    dragImage.style.cssText =
      "position:absolute;top:-9999px;left:-9999px;padding:4px 8px;background:#333;color:#fff;border-radius:4px;font-size:12px;pointer-events:none;";
    document.body.appendChild(dragImage);
    event.dataTransfer.setDragImage(dragImage, 0, 0);
    setTimeout(() => dragImage.remove(), 0);
  };

  const handleDragEnd = () => {
    setActiveDragBlock(null);
  };

  // The row used to take its accessible name from its contents, and its
  // contents included the symbol's port labels — a screen reader read
  // `signal_flow.source.step` out as "Stepout port, signal, outStep". The tile
  // is a picture of the component; the component's name is the label.
  const accessibleName = qualifier ? `${entry.label} (${qualifier})` : entry.label;

  return (
    <button
      type="button"
      className="library-item"
      aria-label={accessibleName}
      title={qualifier ? `${entry.description}\n${qualifier}` : entry.description}
      draggable={true}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onClick={() => {
        onInsert(entry);
      }}
      onDoubleClick={() => {
        onOpenVariants?.(entry);
      }}
    >
      <span className="library-item__preview">
        {entry.symbol?.bbox && entry.ports ? <BlockTile entry={entry} /> : null}
      </span>
      <span className="library-item__label">
        {entry.label}
        {qualifier ? <span className="library-item__qualifier">{qualifier}</span> : null}
      </span>
    </button>
  );
}
