import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "./app/theme";
import { ToastProvider } from "./app/toast";
import { router } from "./router";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) throw new Error("#root not found");

createRoot(rootElement).render(
  <StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </ThemeProvider>
  </StrictMode>,
);
