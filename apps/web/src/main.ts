// SPDX-License-Identifier: AGPL-3.0-or-later
import "@pptaken/ui/fonts.css";
import "@pptaken/ui/tokens.css";
import "@pptaken/ui/components.css";
import "./app.css";
import { applyTheme } from "@pptaken/ui";
import { mount } from "svelte";
import App from "./App.svelte";
import { prefs, startRouter, watchNetwork } from "./lib/state.svelte";

applyTheme(prefs.theme);
document.documentElement.lang = prefs.locale;
startRouter();
watchNetwork();

const target = document.getElementById("app");
if (target) mount(App, { target });
