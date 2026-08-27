import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeMember } from "../test/fixtures";
import { MemberAvatar } from "./MemberAvatar";

describe("MemberAvatar", () => {
  it("renders the Pocket ID picture over the initials fallback", () => {
    const member = makeMember({
      name: "Mira Muster",
      pictureUrl: "https://pocket.example/api/users/1/profile-picture.png",
    });
    const { container } = render(<MemberAvatar member={member} />);

    expect(container.querySelector(".avatar")).toHaveAttribute(
      "data-initials",
      "MM",
    );
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      member.pictureUrl,
    );
    expect(container.querySelector("img")).toHaveAttribute(
      "referrerpolicy",
      "no-referrer",
    );
  });

  it("falls back to initials when the image fails", () => {
    const member = makeMember({
      name: "Mira Muster",
      pictureUrl: "https://pocket.example/avatar.png",
    });
    const { container } = render(<MemberAvatar member={member} />);

    fireEvent.error(container.querySelector("img")!);

    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.querySelector(".avatar")).toHaveAttribute(
      "data-initials",
      "MM",
    );
  });

  it("tries a new picture URL after a previous image failed", () => {
    const member = makeMember({
      pictureUrl: "https://pocket.example/old.png",
    });
    const { container, rerender } = render(<MemberAvatar member={member} />);
    fireEvent.error(container.querySelector("img")!);

    rerender(
      <MemberAvatar
        member={{ ...member, pictureUrl: "https://pocket.example/new.png" }}
      />,
    );

    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://pocket.example/new.png",
    );
  });
});
