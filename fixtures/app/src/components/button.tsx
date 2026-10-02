import type { ComponentProps } from "react";

export function Button(props: ComponentProps<"button">) {
  return <button type="button" className="btn" {...props} />;
}

export function RestButton({ className, ...rest }: ComponentProps<"button">) {
  return <button type="button" className={`btn ${className ?? ""}`} {...rest} />;
}

export function LabelButton({ label }: { label: string }) {
  return <button type="button">{label}</button>;
}
