import chatgpt from "@/assets/providers/chatgpt.svg";
import claude from "@/assets/providers/claude.svg";
import deepseek from "@/assets/providers/deepseek.svg";
import gemini from "@/assets/providers/gemini.svg";
import grok from "@/assets/providers/grok.svg";
import kimi from "@/assets/providers/kimi.svg";
import mimo from "@/assets/providers/mimo.svg";
import minimax from "@/assets/providers/minimax.svg";
import muse from "@/assets/providers/muse.svg";
import type { ProviderKey } from "../../../shared/providers";

// The vendors' own marks, from @lobehub/icons-static-svg 1.95.1 (MIT License,
// Copyright (c) LobeHub); each logo is a trademark of its owner. ChatGPT wears
// the OpenAI mark, MiMo Xiaomi MiMo's, and Muse Spark Meta's. Kimi's K is
// black instead of the colour file's white, which is made for a dark tile.
// Drawn as <img> so the gradient ids inside the files cannot clash.
const LOGOS: Record<ProviderKey, string> = {
  chatgpt,
  claude,
  deepseek,
  gemini,
  grok,
  kimi,
  mimo,
  minimax,
  muse,
};

export function ProviderLogo({
  provider,
  className,
}: {
  provider: ProviderKey;
  className?: string;
}) {
  return (
    <img
      src={LOGOS[provider]}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={className}
    />
  );
}
