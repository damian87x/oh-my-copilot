# Follow-up Research Protocol

When the user has follow-up questions after initial research:

1. **Append** to the same research document — do not create a new file
2. **Update frontmatter**:
   - `last_updated: YYYY-MM-DD`
   - `last_updated_by: [git user.name]`
   - Add `last_updated_note: "Added follow-up research for [brief description]"`
3. **Add a new section** at the end:
   ```markdown
   ## Follow-up Research [ISO timestamp]
   
   ### Question
   [User's follow-up question]
   
   ### Findings
   [New findings with file:line evidence]
   ```
4. **Spawn new agents** as needed (same tier sizing rules apply)
5. **Connect** new findings to existing sections where relevant
