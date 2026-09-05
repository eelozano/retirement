import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePlanStore } from "../../store/planStore";
import { WelcomeScreen } from "./WelcomeScreen";

// #103: the screen a fresh install now opens on, in place of an invented
// household presented as the user's own. What matters here is that the two
// paths off it are explicit, and that neither can produce a plan the engine
// would reject.

const createPlan = vi.fn();
const loadSample = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  createPlan.mockResolvedValue(undefined);
  loadSample.mockResolvedValue(undefined);
  usePlanStore.setState({ createPlan, loadSample, error: null });
});

/** Fills in the one person the form starts with. */
async function nameFirstPerson(name: string) {
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText("Name"));
  await user.type(screen.getByLabelText("Name"), name);
  return user;
}

describe("WelcomeScreen", () => {
  it("offers both paths, and takes neither on its own", () => {
    render(<WelcomeScreen />);

    expect(screen.getByRole("button", { name: "Create plan" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Load the example household" }),
    ).toBeInTheDocument();
    expect(createPlan).not.toHaveBeenCalled();
    expect(loadSample).not.toHaveBeenCalled();
  });

  it("says the example is invented, where the user decides whether to load it", () => {
    render(<WelcomeScreen />);
    const sample = screen.getByRole("region", { name: "Or look around first" });
    expect(sample).toHaveTextContent(/invented/i);
  });

  it("will not create a plan for a nameless person", async () => {
    render(<WelcomeScreen />);

    // A name is the one thing the form cannot guess, so it starts empty and
    // Create stays disabled until it is filled in.
    expect(screen.getByRole("button", { name: "Create plan" })).toBeDisabled();
    expect(screen.getByText("Person 1 needs a name.")).toBeInTheDocument();

    await nameFirstPerson("Sam");
    expect(screen.getByRole("button", { name: "Create plan" })).toBeEnabled();
  });

  it("refuses a retirement date that precedes the birth date", async () => {
    render(<WelcomeScreen />);
    const user = await nameFirstPerson("Sam");

    const retiresYear = screen.getByLabelText("Retires year");
    await user.clear(retiresYear);
    await user.type(retiresYear, "1900");
    await user.tab();

    expect(
      screen.getByText("Sam's retirement date must be after their birth date."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create plan" })).toBeDisabled();
  });

  it("creates a plan from the household as entered", async () => {
    render(<WelcomeScreen />);
    const user = await nameFirstPerson("Sam");

    const birthYear = screen.getByLabelText("Born year");
    await user.clear(birthYear);
    await user.type(birthYear, "1990");
    await user.tab();

    await user.click(screen.getByRole("button", { name: "Create plan" }));

    expect(createPlan).toHaveBeenCalledTimes(1);
    const [name, people] = createPlan.mock.calls[0];
    expect(name).toBe("My plan");
    expect(people).toHaveLength(1);
    expect(people[0].name).toBe("Sam");
    expect(people[0].birth.year).toBe(1990);
  });

  it("collects a second person only when asked, and never more", async () => {
    render(<WelcomeScreen />);
    const user = await nameFirstPerson("Sam");

    await user.click(screen.getByRole("button", { name: "Add a partner" }));
    expect(screen.getAllByLabelText("Name")).toHaveLength(2);
    // A household is one or two people; there is no third slot.
    expect(
      screen.queryByRole("button", { name: "Add a partner" }),
    ).not.toBeInTheDocument();

    // The new person is unnamed, so Create is blocked until they are named.
    expect(screen.getByRole("button", { name: "Create plan" })).toBeDisabled();
    await user.type(screen.getAllByLabelText("Name")[1], "Rae");
    await user.click(screen.getByRole("button", { name: "Create plan" }));

    const [, people] = createPlan.mock.calls[0];
    expect(people.map((p: { name: string }) => p.name)).toEqual(["Sam", "Rae"]);
  });

  it("loads the example household on request", async () => {
    render(<WelcomeScreen />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Load the example household" }));

    expect(loadSample).toHaveBeenCalledTimes(1);
    expect(createPlan).not.toHaveBeenCalled();
  });

  it("shows a failure from the backend rather than swallowing it", () => {
    usePlanStore.setState({ error: "creating plan: permission denied" });
    render(<WelcomeScreen />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "creating plan: permission denied",
    );
  });
});
