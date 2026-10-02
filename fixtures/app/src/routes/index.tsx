import { createFileRoute } from "@tanstack/react-router";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Button, LabelButton, RestButton } from "../components/button.tsx";
import { PortalNote } from "../components/portal-note.tsx";

export const Route = createFileRoute("/")({ component: Home });

const items = ["alpha", "beta", "gamma"];

function Home() {
  return (
    <main id="home">
      <h1>Home</h1>
      <ul id="list">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <Button id="b-props">Props spread</Button>
      <RestButton id="b-rest">Rest spread</RestButton>
      <LabelButton label="No spread" />
      <Tooltip.Provider>
        <Tooltip.Root>
          <Tooltip.Trigger id="tt-trigger">Hover</Tooltip.Trigger>
          <Tooltip.Portal>
            <Tooltip.Content>Tip</Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </Tooltip.Provider>
      <Dialog.Root>
        <Dialog.Trigger id="dlg-trigger">Open</Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content id="dlg-content" aria-describedby={undefined}>
            <Dialog.Title>Dialog</Dialog.Title>
            <Dialog.Close id="dlg-close">Close</Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <PortalNote />
    </main>
  );
}
