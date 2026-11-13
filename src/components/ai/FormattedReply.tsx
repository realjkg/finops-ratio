// Frank's reply as readable prose: a bold heading, paragraphs in the body font,
// short section labels, real lists and a muted source footnote. Built from
// parseReply() as React elements only (no innerHTML), so reply text is never
// treated as markup.

import { Fragment, type ReactNode } from 'react';
import { parseReply, type Inline, type ReplyBlock } from './formatReply';

function Text({ inline }: { inline: Inline[] }): ReactNode {
  return inline.map((s, i) =>
    s.strong ? (
      <strong key={i} className="font-semibold text-txt">
        {s.text}
      </strong>
    ) : (
      <Fragment key={i}>{s.text}</Fragment>
    ),
  );
}

function Block({ block }: { block: ReplyBlock }): ReactNode {
  switch (block.kind) {
    case 'heading':
      return (
        <p className="text-sm font-semibold leading-snug text-txt">
          <Text inline={block.inline.map((s) => ({ ...s, strong: false }))} />
        </p>
      );
    case 'label':
      return (
        <p className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-dim">
          <Text inline={block.inline.map((s) => ({ ...s, strong: false }))} />
        </p>
      );
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i} className="pl-0.5">
          <Text inline={item} />
        </li>
      ));
      return block.ordered ? (
        <ol className="list-decimal space-y-1 pl-5">{items}</ol>
      ) : (
        <ul className="list-disc space-y-1 pl-5 marker:text-purple">{items}</ul>
      );
    }
    case 'source':
      return (
        <p className="mt-1 border-t border-edge pt-2 text-[11px] leading-snug text-dim">
          <Text inline={block.inline} />
        </p>
      );
    default:
      return (
        <p>
          <Text inline={block.inline} />
        </p>
      );
  }
}

export function FormattedReply({ content }: { content: string }) {
  const blocks = parseReply(content);
  return (
    <div className="space-y-2 font-body text-[13px] leading-relaxed text-sub">
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  );
}
