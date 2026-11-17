"use client";

import * as React from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";

import { cn } from "@/lib/cn";
import { Input } from "@/components/ui/input";

function PasswordInput({
  className,
  disabled,
  ...props
}: Omit<React.ComponentProps<"input">, "type">) {
  const [visible, setVisible] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectionRef = useRef<{ start: number; end: number } | null>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;
    const selection = selectionRef.current;
    if (!input || !selection) {
      return;
    }

    input.focus();
    try {
      input.setSelectionRange(selection.start, selection.end);
    } catch {
      // Some browsers block selection on password inputs.
    }
    selectionRef.current = null;
  }, [visible]);

  function toggleVisibility() {
    const input = inputRef.current;
    if (input) {
      selectionRef.current = {
        start: input.selectionStart ?? input.value.length,
        end: input.selectionEnd ?? input.value.length,
      };
    }
    setVisible((current) => !current);
  }

  return (
    <div className="relative">
      <Input
        className={cn("pr-12", className)}
        disabled={disabled}
        {...props}
        ref={inputRef}
        type={visible ? "text" : "password"}
      />
      <button
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        className="absolute top-1/2 right-1.5 flex size-9 -translate-y-1/2 items-center justify-center rounded-lg text-(--secondary) transition-colors hover:bg-(--hover) hover:text-(--fg) focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        disabled={disabled}
        onClick={toggleVisibility}
        type="button"
      >
        {visible ? (
          <EyeOffIcon aria-hidden="true" className="size-5" />
        ) : (
          <EyeIcon aria-hidden="true" className="size-5" />
        )}
      </button>
    </div>
  );
}

export { PasswordInput };
