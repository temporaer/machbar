import { useEffect, useState } from "react";
import type { Member } from "@machbar/shared";
import { fallbackColor, initials } from "../lib/format";

type AvatarMember = Pick<Member, "id" | "name" | "color" | "pictureUrl">;

export type MemberAvatarSize = "xs" | "sm" | "md" | "lg";

export function MemberAvatar({
  member,
  size = "md",
  className = "",
}: {
  member: AvatarMember;
  size?: MemberAvatarSize;
  className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const pictureUrl =
    member.pictureUrl && member.pictureUrl !== failedUrl
      ? member.pictureUrl
      : null;

  useEffect(() => {
    setFailedUrl(null);
  }, [member.pictureUrl]);

  return (
    <span
      className={`avatar avatar-${size}${className ? ` ${className}` : ""}`}
      style={{ background: member.color || fallbackColor(member.id) }}
      data-initials={initials(member.name)}
      aria-hidden="true"
    >
      {pictureUrl ? (
        <img
          className="avatar-image"
          src={pictureUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(pictureUrl)}
        />
      ) : null}
    </span>
  );
}

export function MemberLabel({
  member,
  label = member.name,
  size = "xs",
  className = "",
}: {
  member: AvatarMember;
  label?: string;
  size?: MemberAvatarSize;
  className?: string;
}) {
  return (
    <span className={`member-label${className ? ` ${className}` : ""}`}>
      <MemberAvatar member={member} size={size} />
      <span>{label}</span>
    </span>
  );
}
