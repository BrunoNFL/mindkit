import { readdir, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { BaseAdapter } from './base.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type {
  ToolDetection,
  TemplateConfig,
  InstallResult,
  ComponentType,
  PathTransform,
} from '../../types/index.js';

/**
 * Adapter for Gemini CLI
 *
 * Structure:
 * - ~/.gemini/agents/*.md (Agent definitions)
 * - ~/.gemini/skills/<name>/SKILL.md (Skill definitions)
 * - ~/.gemini/settings.json (Global settings)
 * - .gemini/settings.json (Project-level settings)
 */
export class GeminiAdapter extends BaseAdapter {
  readonly tool = 'gemini' as const;
  readonly name = 'Gemini CLI';
  readonly description = 'Google Gemini CLI';

  private readonly globalDir = join(homedir(), '.gemini');

  getGlobalConfigDir(): string {
    return this.globalDir;
  }

  getProjectConfigPath(projectRoot: string): string {
    return join(projectRoot, '.gemini/settings.json');
  }

  async detect(): Promise<ToolDetection> {
    const configExists = await this.pathExists(this.globalDir);
    const settingsPath = join(this.globalDir, 'settings.json');
    const settingsExist = await this.pathExists(settingsPath);

    // Check if 'gemini' command exists in PATH
    const commandExists = this.commandExists('gemini');

    // Tool is installed if command exists OR if config directory with settings exists
    const installed = commandExists || (configExists && settingsExist);

    return {
      tool: this.tool,
      installed,
      configPath: configExists ? this.globalDir : null,
    };
  }

  protected getDefaultTransforms(projectRoot?: string): PathTransform[] {
    return [
      { type: 'variable', from: 'DOCS', to: join(this.globalDir, 'docs') },
      { type: 'variable', from: 'PROJECT', to: projectRoot || '.' },
      { type: 'variable', from: 'HOME', to: homedir() },
      { type: 'variable', from: 'CONFIG', to: this.globalDir },
    ];
  }

  /**
   * Prepares the content for a Gemini skill by ensuring mandatory frontmatter
   * and proper instruction tags.
   */
  private prepareSkillContent(content: string, template: TemplateConfig): string {
    let frontmatter: Record<string, any> = {};
    let body = content;

    const match = content.match(/^---([\s\S]+?)---([\s\S]*)$/);
    if (match) {
      try {
        frontmatter = parseYaml(match[1]);
        body = match[2].trim();
      } catch {
        // Fallback if parsing fails
      }
    }

    // Ensure mandatory frontmatter
    frontmatter.name = frontmatter.name || template.name;
    frontmatter.description = frontmatter.description || template.description;

    // Enforcement for interactive questioning for specific skills
    const interactiveSkills = ['create-prd', 'generate-spec', 'generate-tasks'];
    if (interactiveSkills.includes(template.name)) {
      const enforcement = `
<critical>
## MANDATORY TOOL USAGE: ask_user
You ARE NOT ALLOWED to proceed to the drafting, generation, or file creation phase without first using the \`ask_user\` tool.
1. You MUST formulate your clarifying questions and pass them directly to the \`ask_user\` tool.
2. DO NOT simply output the questions as markdown text in your response. You MUST use the tool.
3. You MUST wait for the tool output (user answers) before moving to any other phase.
4. This is a strict operational requirement. Failure to use the \`ask_user\` tool for questioning is a violation of your core instructions.
</critical>
`;
      body = enforcement + body;

      // Ensure ask_user is in the allowed tools
      let tools = frontmatter['allowed-tools'] || frontmatter['tools'] || '';
      if (typeof tools === 'string') {
        if (!tools.includes('ask_user')) {
          tools = tools ? `${tools}, ask_user` : 'ask_user';
        }
        frontmatter['allowed-tools'] = tools;
      } else if (Array.isArray(tools)) {
        if (!tools.includes('ask_user')) {
          tools.push('ask_user');
        }
        frontmatter['allowed-tools'] = tools;
      }
    }

    // Convert system_instructions to instructions for Gemini skills
    body = body.replace(/<system_instructions>/g, '<instructions>');
    body = body.replace(/<\/system_instructions>/g, '</instructions>');

    // If no instructions tags exist, wrap the whole body
    if (!body.includes('<instructions>')) {
      body = `<instructions>\n${body}\n</instructions>`;
    }

    return `---\n${stringifyYaml(frontmatter)}---\n\n${body}`;
  }

  async install(
    template: TemplateConfig,
    content: string,
    projectRoot?: string
  ): Promise<InstallResult> {
    const target = template.targets.gemini;
    if (!target) {
      return {
        template,
        tool: this.tool,
        success: false,
        targetPath: '',
        error: 'No Gemini target configured for this template',
      };
    }

    try {
      // Apply transforms to content
      const transforms = [
        ...this.getDefaultTransforms(projectRoot),
        ...(template.transforms || []),
      ];
      let transformedContent = this.transformContent(content, transforms);

      // Transform and expand target path
      let targetPath = this.transformPath(target.path, projectRoot);
      if (targetPath.startsWith('~')) {
        targetPath = targetPath.replace('~', homedir());
      } else if (projectRoot && !targetPath.startsWith('/')) {
        targetPath = join(projectRoot, targetPath);
      }

      // Special handling for skills, agents, and commands which are installed as skills
      if (template.type === 'skills' || template.type === 'agents' || template.type === 'commands') {
        const skillDir = dirname(targetPath);
        await mkdir(skillDir, { recursive: true });
        
        // Final transformation for Gemini skill format
        transformedContent = this.prepareSkillContent(transformedContent, template);
      }

      await this.writeConfig(targetPath, transformedContent);

      return {
        template,
        tool: this.tool,
        success: true,
        targetPath,
      };
    } catch (error) {
      return {
        template,
        tool: this.tool,
        success: false,
        targetPath: target.path,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async listInstalled(type: ComponentType): Promise<string[]> {
    const dirMap: Record<ComponentType, string> = {
      commands: join(this.globalDir, 'skills'), // All are now installed as skills
      agents: join(this.globalDir, 'skills'),
      skills: join(this.globalDir, 'skills'),
      templates: join(this.globalDir, 'docs'),
    };

    const dir = dirMap[type];
    if (!(await this.pathExists(dir))) {
      return [];
    }

    try {
      const entries = await readdir(dir, { withFileTypes: true });

      if (type === 'skills' || type === 'agents' || type === 'commands') {
        // Skills, Agents and Commands are directories with SKILL.md inside
        const skills: string[] = [];
        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (await this.pathExists(join(dir, entry.name, 'SKILL.md'))) {
              skills.push(entry.name);
            }
          }
        }
        return skills;
      }

      // Templates are .md files
      return entries
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => e.name.replace('.md', ''));
    } catch {
      return [];
    }
  }
}
