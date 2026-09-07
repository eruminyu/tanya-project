import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import { App } from "./App";
import { SettingsApp } from "./SettingsApp";
import { shouldRenderSettingsWindow } from "./web-layout";
import "./styles.css";

const settingsWindow = shouldRenderSettingsWindow(
  new URLSearchParams(window.location.search).get("window") === "settings",
  isTauri(),
);
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{settingsWindow ? <SettingsApp /> : <App />}</React.StrictMode>,
);
