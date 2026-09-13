import { Link } from "@tanstack/react-router";

export function Header() {
  return (
    <header className="header">
      <div className="header__inner container">
        <Link to="/" className="brand" aria-label="starwatch home">
          <span className="brand__mark" aria-hidden="true">
            ★
          </span>
          starwatch
        </Link>
        <p className="header__tagline">search anyone&apos;s GitHub stars</p>
      </div>
    </header>
  );
}
