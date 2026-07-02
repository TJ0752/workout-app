export default function Logo({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="28" cy="28" r="24" fill="none" stroke="var(--accent-soft)" strokeWidth="6" />
      <circle
        cx="28"
        cy="28"
        r="24"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="6"
        strokeDasharray="150.8"
        strokeDashoffset="37.7"
        strokeLinecap="round"
        transform="rotate(-90 28 28)"
      />
      <path
        d="M18 28 L25 35 L38 21"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
