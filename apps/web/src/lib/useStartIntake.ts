import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "./api";
import { localizedErrorMessage } from "./errorMessage";
import { useStrings } from "./strings";

export function useStartIntake() {
  const navigate = useNavigate();
  const strings = useStrings();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = useCallback(
    async (input: {
      text?: string | null;
      files?: readonly File[];
      scope?: "household" | "work";
    }) => {
      setPending(true);
      setError(null);
      try {
        const result = await api.createIntake(input);
        navigate(`/intake/${result.id}`);
      } catch (cause) {
        setError(localizedErrorMessage(cause, strings));
        throw cause;
      } finally {
        setPending(false);
      }
    },
    [navigate, strings],
  );
  return { start, pending, error };
}
