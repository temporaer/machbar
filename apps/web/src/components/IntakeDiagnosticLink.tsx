import { useStrings } from "../lib/strings";

export function IntakeDiagnosticLink({ href }: { href: string }) {
  const strings = useStrings();
  return (
    <div className="intake-diagnostic-link">
      <a href={href} target="_blank" rel="noopener noreferrer">
        {strings.intakeOpenDiagnostics}
      </a>
      <small>{strings.intakeOpenDiagnosticsHelp}</small>
    </div>
  );
}
