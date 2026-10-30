import type { SVGProps } from "react";

/** Provisional Earlyscript monogram, pending a final visual identity. */
export function BrandIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M5 3h14v4H9v3h8v4H9v3h10v4H5Z" fill="currentColor" />
    </svg>
  );
}
