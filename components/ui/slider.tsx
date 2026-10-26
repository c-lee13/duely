import * as React from "react"
import { cn } from "cn"

/** A native range input styled to match the other form controls. Keyboard, touch and screen-reader support come from the browser. */
function Slider({ className, style, min = 0, max = 100, value, ...props }: Omit<React.ComponentProps<"input">, "type">) {
  // Fill the track up to the thumb so the chosen share is visible, not just the thumb position.
  const pct = ((Number(value) - Number(min)) / (Number(max) - Number(min))) * 100
  return (
    <input
      type="range"
      data-slot="slider"
      min={min}
      max={max}
      value={value}
      style={{ ...style, ["--slider-fill" as string]: `${Number.isFinite(pct) ? pct : 0}%` }}
      className={cn(
        "h-2 w-full cursor-pointer appearance-none rounded-full bg-[linear-gradient(to_right,var(--color-primary)_var(--slider-fill),var(--color-muted)_var(--slider-fill))] outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        "[&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow",
        "[&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-background [&::-moz-range-thumb]:bg-primary",
        className
      )}
      {...props}
    />
  )
}

export { Slider }
