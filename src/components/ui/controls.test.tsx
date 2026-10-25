import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Checkbox, NumberField, Segmented, Stepper } from "./controls";

describe("custom controls", () => {
  it("Checkbox toggles from its label and is not a native input", async () => {
    const onChange = vi.fn<(v: boolean) => void>();
    const { container } = render(
      <Checkbox checked={false} onCheckedChange={onChange} label="Sign out first" />,
    );
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    await userEvent.click(screen.getByText("Sign out first"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("NumberField commits on Enter, steps with arrows, and reverts invalid input", async () => {
    const onCommit = vi.fn<(v: number) => void>();
    render(
      <NumberField
        value={5000}
        min={1000}
        max={9000}
        step={1000}
        onCommit={onCommit}
        aria-label="Lines"
      />,
    );
    const field = screen.getByRole("spinbutton", { name: "Lines" });
    expect(field).not.toHaveAttribute("type", "number");
    await userEvent.clear(field);
    await userEvent.type(field, "7000{Enter}");
    expect(onCommit).toHaveBeenLastCalledWith(7000);
    await userEvent.clear(field);
    await userEvent.type(field, "99999{Enter}");
    expect(field).toHaveValue("5000");
    await userEvent.type(field, "{ArrowUp}");
    expect(onCommit).toHaveBeenLastCalledWith(6000);
  });

  it("Stepper respects its bounds", async () => {
    const onChange = vi.fn<(v: number) => void>();
    render(<Stepper label="font size" value={9} min={9} max={32} onChange={onChange} />);
    expect(screen.getByRole("button", { name: "Decrease font size" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Increase font size" }));
    expect(onChange).toHaveBeenCalledWith(10);
  });

  it("Segmented selects an option", async () => {
    const onChange = vi.fn<(v: "a" | "b") => void>();
    render(
      <Segmented
        label="Mode"
        value="a"
        onChange={onChange}
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("radio", { name: "Beta" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });
});
