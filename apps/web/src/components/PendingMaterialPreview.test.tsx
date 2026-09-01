import { expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/testUtils";
import { PendingMaterialPreview } from "./PendingMaterialPreview";

it("does not decode a full-resolution pending camera image", () => {
  const createObjectURL = vi.spyOn(URL, "createObjectURL");

  renderWithProviders(
    <PendingMaterialPreview
      files={[new File(["image"], "camera.jpg", { type: "image/jpeg" })]}
    />,
  );

  expect(screen.getByText("camera.jpg")).toBeInTheDocument();
  expect(screen.getByText("IMG")).toBeInTheDocument();
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(createObjectURL).not.toHaveBeenCalled();
});
