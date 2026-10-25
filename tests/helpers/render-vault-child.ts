/** Renders the Vault preview to static HTML on stdout. Separate from the shared renderer so the vault stays independent of it. */
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { VaultPreview } from "@/components/duely/vault-preview"

process.stdout.write(renderToStaticMarkup(React.createElement(VaultPreview)))
