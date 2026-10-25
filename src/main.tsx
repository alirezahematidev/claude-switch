import "@/styles/globals.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { TooltipProvider } from "@/components/ui/tooltip";
import { createQueryClient } from "@/lib/queries";

import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

const queryClient = createQueryClient();

// Native-app feel: no browser context menu outside text fields and terminals.
document.addEventListener("contextmenu", (event) => {
  const target = event.target;
  if (!(target instanceof Element) || !target.closest("input, textarea, .selectable, .xterm")) {
    event.preventDefault();
  }
});

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={400}>
        <App />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
