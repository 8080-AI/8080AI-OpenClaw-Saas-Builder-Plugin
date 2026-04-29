import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "test",
  name: "test",
  register(api) {
    console.log("API Keys:", Object.keys(api));
    console.log("Runtime Keys:", Object.keys(api.runtime));
    if (api.runtime.ui) console.log("UI Keys:", Object.keys(api.runtime.ui));
  }
});
