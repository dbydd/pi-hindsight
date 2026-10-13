import {
  getBuiltInBankTemplate,
  listBankTemplatesForAgentUse,
  listBuiltInBankTemplates,
  resolveBankTemplateManifest,
} from "../banks/bank-templates.js";
import { resolveProjectIdentity } from "../banks/banking.js";
import { resolveOperationBank } from "../banks/bank-selection.js";
import { seedKnowledgePages } from "../banks/knowledge-page-seed.js";
import { resolveMentalModelScopeTags } from "../banks/mm-scope-tags.js";
import type { MemoryOperationsDeps } from "./memory-operation-types.js";

export function createBankTemplateOperations(deps: MemoryOperationsDeps) {
  return {
    listBankTemplates() {
      return listBuiltInBankTemplates();
    },

    listBankTemplatesForAgentUse() {
      return listBankTemplatesForAgentUse(deps.getConfig().agentUse);
    },

    async applyBankTemplate(args: { templateId: string; dryRun?: boolean }) {
      const template = getBuiltInBankTemplate(args.templateId);
      if (!template) {
        throw new Error(
          `Unknown bank template id: ${args.templateId}. Open /hindsight and press t to list sets for the current agent use.`,
        );
      }
      const client = deps.getClient();
      if (!client.importBankTemplate) {
        throw new Error("Hindsight client does not support bank template import.");
      }
      const config = deps.getConfig();
      // Each bundled template already declares which bank kind it targets, so apply resolves
      // that bank directly instead of taking a separate --bank override.
      const bankId = resolveOperationBank({
        requestedBank: template.target === "user" ? "global" : undefined,
        config,
        projectBankId: deps.getProjectBankId(),
      });
      const bankMissionSettings =
        template.target === "user" ? config.banks.user : config.banks.project;
      const cwd = (deps as { getCwd?: () => string }).getCwd?.() ?? process.cwd();
      const resolvedProjectId =
        template.target === "project" ? resolveProjectIdentity(cwd, config).projectId : undefined;
      // Seed the project scope tag the target bank actually reports. A model's refresh filters
      // observations by its tags with an implicit `all_strict`, so a tag the bank does not carry
      // would produce an empty document at first refresh.
      const derivedScope =
        template.target === "project"
          ? await resolveMentalModelScopeTags({
              client,
              bankId,
              identityTags: resolvedProjectId ? [`project:${resolvedProjectId}`] : [],
            })
          : undefined;
      const manifest = resolveBankTemplateManifest(template, bankMissionSettings, {
        ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
        ...(derivedScope ? { scopeTags: derivedScope.tags } : {}),
      });
      const dryRun = args.dryRun ?? true;
      const result = await client.importBankTemplate(bankId, manifest, { dryRun });
      // Coding project templates also seed the knowledge-page taxonomy when the server supports pages.
      let knowledgeSeed: Awaited<ReturnType<typeof seedKnowledgePages>> | undefined;
      if (template.id === "pi-coding-project") {
        const baseTags = [
          "source:pi",
          ...(resolvedProjectId ? [`project:${resolvedProjectId}`] : []),
        ];
        knowledgeSeed = await seedKnowledgePages({
          client,
          bankId,
          baseTags,
          dryRun,
        });
      }
      return {
        bankId,
        template,
        dryRun,
        result,
        ...(knowledgeSeed ? { knowledgeSeed } : {}),
      };
    },
  };
}
