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
Unclear captures go to **Eingang** as unclassified items. A concrete action can
be marked **Machbar** immediately, and a multi-step outcome can start as a
project.

Installed Android PWAs can receive text and URLs from the operating-system
share sheet. Incoming material can create new work or be appended to an
existing task or project.
New camera photos can be cropped before capture or attached unchanged. The
crop editor opens only on request so selecting a full-resolution photo does not
decode it unnecessarily on memory-constrained phones.

### 2. Clarify

Decide what the capture means:

- Is there one concrete physical or digital action?
- Is an outcome made of several steps?
- Who is responsible for keeping it moving?
- Is it blocked or waiting on someone?
- Does it need a date, follow-up, context, or supporting notes?

Clarification is separate from capture so that fast collection does not force
premature planning.

An inbox item leaves clarification through one explicit classification:

- **Machbar** keeps it as a task and makes it actionable.
- **Irgendwann** keeps it as a task outside the current action lists.
- **In Schritte zerlegen** promotes it to a project and opens the lightweight
  handoff for adding a first action. Starting the project remains an explicit
  decision once it has a driver and a viable progress or future-waiting path.
- **Backlog** promotes it to a backlog project.

Promotion keeps the captured title, notes, dates, tags, and sensible ownership.
Existing child tasks become project-root steps while deeper task nesting stays
intact; the temporary capture wrapper is removed.

### 3. Execute

**Heute** is derived rather than manually curated. It combines the selected
person’s planned work, deadlines, due-soon tasks, reached follow-ups, standalone
available work, and the next useful action from each active project.

The compact **Meine | Alle** toggle can broaden this to the whole household
without changing who is signed in or who is recorded as making changes.

The goal is not to display every open task. Ordinary unscheduled project work
is pulled in canonical outline order: **Meine** selects the first action owned
by the selected person or shared with the household, while **Alle** can preserve
one independent owner/shared lane per project. A real task date still surfaces
that task even when it is not the structural next action.

### 4. Wait and follow up

Waiting is explicit blocker data, not a lifecycle status or hidden note. An
actionable task can wait on an external person, organization, event, or
delivery, identified by a required reason. Without a reason, the task is not
waiting. The wait has its own optional **Wiedervorlage**: once reached, the
directly waiting task returns to Today for attention. Its planned work date
stays independent and remains stored while the task is blocked. Follow-up
notes preserve an attributed history. A reached Wiedervorlage does not make
its project structurally stuck unless a separate project defect also exists.

Dependencies can also block a task until prerequisite work is complete. A
task may have both blocker types and becomes executable only after all of them
are resolved. The **Wartet** view shows tasks with a direct external wait once
with their actual blocker context. Tasks blocked only by another task stay in
their project, avoiding duplicate entries for the same external wait.

### 5. Review

**Review** is one derived maintenance queue. It identifies organized work whose
structure or continued state needs an intentional decision, for example:

- an active project has no driver or useful progress path;
- an external wait has no future revisit;
- a dependency chain has no useful path forward;
- all tasks are finished but the project itself has not been reviewed;
- active, backlog, or standalone Someday work has reached its review age.

Ordinary shared tasks, missing acceptance criteria, Inbox captures, reached
follow-ups, and past planning dates are not review debt. Keeping an item active,
parked, or for later explicitly acknowledges it; merely opening it does not.
Review age never adds work to Today. Healthy future waiting follows its own
revisit date rather than generic inactivity.

Optional owner/effort planning tools remain available inside Review without
becoming another required workflow.

### 6. Inventory

**Alles** is exhaustive access to every non-deleted ordinary project and task.
Projects and standalone task trees appear as first-class inventory. Project
details own their complete outlines so descendants are not dumped twice by
default; search can still return a matching nested task directly.

Alles answers where an item is even when Today, Review, Inbox, and Waiting do
not currently surface it.

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
reviews the outcome against its acceptance criteria. Criteria are optional, but
once present they are binding: every remaining criterion must be checked before
completion. Starting a project requires a driver plus an executable progress
path or intentional healthy future waiting.

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

- **Share into Machbar:** receive a title, text, URL, images, and files; create
  a task or project, or append the material to existing notes. File shares use
  the same destination choices as text shares and survive sign-in.
- **Share from Machbar:** send readable task/project text and a deep link
  through Web Share, with a clipboard fallback.

Deep-link recipients still need network and authentication access to the same
Machbar deployment.

When the optional Paperless-ngx integration is configured, the Markdown editor
can capture a phone photo, choose an image or file, or reference an existing
Paperless document. Paperless stores the bytes; Machbar notes contain only
stable `paperless:<id>` references.

The global `+` action also accepts a photo or file before a task/project exists.
The material remains on the device until the user commits the Capture form.
Existing tasks and projects expose a paperclip action that appends material
without first opening notes editing. Detail views show all referenced material
compactly; task lists show at most the first thumbnail plus an overflow count.
