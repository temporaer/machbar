# Household workflow

Machbar is built around a simple problem: household work is shared, but
responsibility and next steps are often not.

A message such as “we need to sort out the insurance” may describe a project,
a reminder, a delegated task, or something waiting on an external response.
Machbar lets the household capture that thought immediately and add structure
later.

## The basic loop

### 1. Capture

Record an idea, request, link, or commitment without completing a form first.
Unclear captures go to **Eingang**. A concrete action can be marked
**Machbar** immediately, and a multi-step outcome can start as a project.

Installed Android PWAs can receive text and URLs from the operating-system
share sheet. Incoming material can create new work or be appended to an
existing task or project.

### 2. Clarify

Decide what the capture means:

- Is there one concrete physical or digital action?
- Is an outcome made of several steps?
- Who is responsible for keeping it moving?
- Is it blocked or waiting on someone?
- Does it need a date, follow-up, context, or supporting notes?

Clarification is separate from capture so that fast collection does not force
premature planning.

### 3. Act

**Heute** is derived rather than manually curated. It combines the selected
person’s planned work, deadlines, due-soon tasks, reached follow-ups, and
projects that need attention.

The goal is not to display every open task. It is to show work that is
currently relevant while keeping the underlying project structure available.

### 4. Wait and follow up

Waiting is a first-class state, not a hidden note. A waiting task records what
or whom it is waiting for. A follow-up date brings it back for attention, and
follow-up notes preserve an attributed history.

Dependencies can also block a task until prerequisite work is complete.

### 5. Review

Machbar identifies projects that need a decision, for example:

- there is no clarified next action;
- the available action has no owner;
- every remaining task is waiting without a follow-up;
- a dependency chain has no useful path forward;
- all tasks are finished but the project itself has not been reviewed.

Project clarification and task refinement views support a deliberate review
without making those activities part of the daily Today screen.

## People and responsibility

Machbar distinguishes project accountability from task assignment.

An active project has one **driver**: the person responsible for keeping the
outcome moving and noticing when it is stuck. Individual tasks can belong to
other people, inherit responsibility from the project or parent task, or
remain shared.

This is deliberately lightweight. The driver is not a manager or exclusive
executor; it is the household member who currently holds the thread.

## Projects describe outcomes

A project represents a result that requires more than one action. It contains:

- a title describing the outcome;
- free-form Markdown notes for context and decisions;
- ordered, checkable acceptance criteria under “Erledigt, wenn …”;
- a driver, dates, tags, and a nested task outline.

Projects move through backlog, active, completed, and archived states. Machbar
does not automatically complete a project when its tasks are done; a person
reviews the outcome against its acceptance criteria.

![Machbar's mobile Projects view with active and stuck household projects](images/projects-mobile.png)

## Tasks, outlines, and dependencies

Tasks can be nested to arbitrary depth. A project outline can be reorganized
with drag, touch, keyboard controls, or a searchable move sheet.

Responsibility and tags can flow down from a project or parent task. A child
can override or explicitly exclude inherited values when the general context
does not apply.

Dependencies express execution order across tasks. A sequence helper can
create several steps where each later step waits for the preceding one.

## Tags and effort

Reusable tags can represent areas, people or organizations, contexts, or
general labels. Project tags flow into their task tree unless excluded, and
lists can group work by selected tag kinds.

Optional S/M/L/XL effort is a household planning aid. It helps reveal work
that may be too large or unevenly distributed; it does not calculate velocity
or introduce sprint commitments.

## Method influences

Machbar borrows tools, not doctrine:

| Influence | Adaptation in Machbar |
|-----------|-----------------------|
| **GTD** | Fast capture, clarification, next actions, Waiting, Someday, and review-oriented views |
| **org-mode** | Nested outlines, lightweight metadata, notes close to tasks, and structure that remains editable |
| **Scrum** | Outcome-oriented projects, completion criteria, a visible driver, backlog clarification, and effort refinement |

There are no required sprints, stand-ups, story points, or formal review
ceremonies. The household decides how much structure is useful.

## Mobile interaction

The primary controls are sized for touch. Common workflow transitions are
available through a configurable right swipe, while a left swipe or overflow
button reveals focused actions. Status remains a read-only badge; named
buttons perform only transitions that are legal for the current item.

Gestures are shortcuts rather than requirements. The same work remains
available through visible buttons, sheets, and keyboard-accessible controls.

## Sharing

Machbar participates in both directions:

- **Share into Machbar:** receive a title, text, and URL; create a task or
  project, or append the material to existing notes.
- **Share from Machbar:** send readable task/project text and a deep link
  through Web Share, with a clipboard fallback.

Deep-link recipients still need network and authentication access to the same
Machbar deployment.
