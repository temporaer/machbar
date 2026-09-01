import type { InheritanceMode, Member } from "@machbar/shared";
import type { RefObject } from "react";
import { useLocale } from "../lib/locale";
import { sortMembersByName } from "../lib/sortOrder";
import { useStrings } from "../lib/strings";
import { MemberAvatar } from "./MemberAvatar";

export interface TaskOwnerChoice {
  ownerMemberId: number | null;
  ownerInheritanceMode: InheritanceMode;
}

export function TaskOwnerChoiceGroup({
  label,
  members,
  ownerMemberId,
  ownerInheritanceMode,
  inheritedOwnerId,
  inheritanceSource,
  onChange,
  focusRef,
}: {
  label: string;
  members: Member[];
  ownerMemberId: number | null;
  ownerInheritanceMode: InheritanceMode;
  inheritedOwnerId: number | null;
  inheritanceSource: "parent" | "project" | null;
  onChange: (choice: TaskOwnerChoice) => void;
  focusRef?: RefObject<HTMLButtonElement>;
}) {
  const strings = useStrings();
  const { locale } = useLocale();
  const orderedMembers = sortMembersByName(members, locale);
  const inheritedOwner =
    inheritedOwnerId === null
      ? null
      : members.find((member) => member.id === inheritedOwnerId);
  const inheritedOwnerName =
    inheritedOwner?.name ??
    (inheritedOwnerId === null ? strings.sharedOwner : strings.unknownMember);
  const selectedKey =
    ownerInheritanceMode === "inherit" && inheritanceSource !== null
      ? "inherit"
      : ownerInheritanceMode === "explicit" &&
          ownerMemberId !== null &&
          members.some((member) => member.id === ownerMemberId)
        ? `member-${ownerMemberId}`
        : "shared";
  const inheritanceLabel =
    inheritanceSource === "parent"
      ? strings.ownerInheritFromParent(inheritedOwnerName)
      : strings.ownerInheritFromProject(inheritedOwnerName);

  return (
    <div className="choice-group" role="group" aria-label={label}>
      {inheritanceSource !== null ? (
        <button
          ref={selectedKey === "inherit" ? focusRef : undefined}
          type="button"
          className="choice-chip"
          aria-pressed={selectedKey === "inherit"}
          onClick={() =>
            onChange({
              ownerMemberId: null,
              ownerInheritanceMode: "inherit",
            })
          }
        >
          {inheritedOwner ? (
            <MemberAvatar member={inheritedOwner} size="xs" />
          ) : null}
          {inheritanceLabel}
        </button>
      ) : null}
      <button
        ref={selectedKey === "shared" ? focusRef : undefined}
        type="button"
        className="choice-chip"
        aria-pressed={selectedKey === "shared"}
        onClick={() =>
          onChange({
            ownerMemberId: null,
            ownerInheritanceMode: "none",
          })
        }
      >
        {strings.sharedOwner}
      </button>
      {orderedMembers.map((member) => {
        const key = `member-${member.id}`;
        return (
          <button
            key={member.id}
            ref={selectedKey === key ? focusRef : undefined}
            type="button"
            className="choice-chip"
            aria-pressed={selectedKey === key}
            onClick={() =>
              onChange({
                ownerMemberId: member.id,
                ownerInheritanceMode: "explicit",
              })
            }
          >
            <MemberAvatar member={member} size="xs" />
            {member.name}
          </button>
        );
      })}
    </div>
  );
}
