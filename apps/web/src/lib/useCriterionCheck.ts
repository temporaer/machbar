import { useCallback, useRef, useState } from "react";
import { api } from "./api";
import { useRefresh } from "./refresh";
import { useStrings } from "./strings";
import { localizedErrorMessage } from "./errorMessage";

/**
 * The one "check/uncheck a criterion" mutation. Shared by the full
 * structural editor (`AcceptanceCriteriaEditor`/`StoryCriteriaSheet`) and
 * the lightweight read/check `Ergebnis` projection on the project detail
 * page -- checking a criterion is direct manipulation everywhere, so both
 * surfaces call the same `api.checkCriterion` write and refresh bus rather
 * than each re-implementing the request/error handling.
 */
export function useCriterionCheck(projectId: number) {
  const { bump } = useRefresh();
  const strings = useStrings();
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<number | null>(null);

  const check = useCallback(
    async (criterionId: number, checked: boolean) => {
      if (pendingRef.current !== null) return;
      pendingRef.current = criterionId;
      setPendingId(criterionId);
      setError(null);
      try {
        await api.checkCriterion(projectId, criterionId, checked);
        bump();
      } catch (err) {
        setError(localizedErrorMessage(err, strings));
      } finally {
        pendingRef.current = null;
        setPendingId(null);
      }
    },
    [projectId, bump, strings],
  );

  return { check, pendingId, error };
}
