# Project Instructions

## TypeScript and React

- Never use `any` or `unknown` unless 100% necessary or specifically requested.
- Do not use `React.*`; import `*` from `react` and use it directly.
- Put each React component in its own file, don't define multiple components in one file.
- Use kebab-case for files and folders.
- Do not use JSX fragment shorthand `<>...</>`, always use React Fragment `<Fragment>...</Fragment>`

### Component Props

- Use a named `interface ComponentNameProps` for props declarations.
- Add a props interface only when the component actually accepts props.
- Prefer typed functional components: `const ComponentName: FC<Props> = (props) => {}` or `const ComponentName: FC = () => {}`.
- Do not type or destructure object parameters inline in function signatures. Accept `props` or another named parameter and destructure inside the function body.

```tsx
import { type FC } from "react";

interface ExampleProps {
  title: string;
  onPress: () => void;
}

export const Example: FC<ExampleProps> = (props) => {
  const { title, onPress } = props;
};
```

### Conditional Rendering

- Avoid JSX ternaries that render `null`. Use short-circuit rendering instead:

```tsx
{
  visible && <Content />;
}
```

- Keep nested ternaries shallow. Do not nest ternaries deeper than one level.

## Code Style

- Always strive for concise, simple solutions.
- Prefer inline styles over `StyleSheet.create`.
- If a problem can be solved in a simpler way, propose it.
- Long term maintainability is a core priority.
- If you add new functionality, first check if there is shared logic that can be extracted to a separate module.
- Duplicate logic across multiple files is a code smell and should be avoided.
- Don't be afraid to change existing code.
- Don't take shortcuts by just adding local logic to solve a problem.

## Tooling

- Use bun unless specifically told to.
- Don't use npm or yarn.

### Commands

- Don't run dev server commands (e.g. `bun dev`) - assume it's already running.
- Don't run build commands unless specifically told to.
- Focus on checking commands like `bun run typecheck`, `bun run lint`, etc.
