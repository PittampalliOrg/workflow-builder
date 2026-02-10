import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { type ProjectRole, projectMembers, projects } from "./db/schema";
import { generateId } from "./utils/id";

/**
 * Get or create a default project for a user.
 * Each user gets one default project on first sign-in.
 */
export async function getOrCreateDefaultProject(
  userId: string,
  platformId: string
): Promise<{ id: string; displayName: string; externalId: string }> {
  // Check if user already has a project
  const existingMembership = await db
    .select({
      id: projects.id,
      displayName: projects.displayName,
      externalId: projects.externalId,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(eq(projectMembers.userId, userId))
    .limit(1);

  if (existingMembership.length > 0) {
    return existingMembership[0];
  }

  // Create new project
  const projectId = generateId();
  const externalId = generateId();
  const now = new Date();

  await db.insert(projects).values({
    id: projectId,
    platformId,
    ownerId: userId,
    displayName: "My Project",
    externalId,
    createdAt: now,
    updatedAt: now,
  });

  // Add user as ADMIN member
  await db.insert(projectMembers).values({
    projectId,
    userId,
    role: "ADMIN",
    createdAt: now,
    updatedAt: now,
  });

  return { id: projectId, displayName: "My Project", externalId };
}

/**
 * List all projects the user is a member of.
 */
export async function listProjects(userId: string): Promise<
  Array<{
    id: string;
    displayName: string;
    externalId: string;
    role: ProjectRole;
  }>
> {
  const results = await db
    .select({
      id: projects.id,
      displayName: projects.displayName,
      externalId: projects.externalId,
      role: projectMembers.role,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(eq(projectMembers.userId, userId));

  return results as Array<{
    id: string;
    displayName: string;
    externalId: string;
    role: ProjectRole;
  }>;
}

/**
 * Get all members of a project.
 */
export async function getProjectMembers(
  projectId: string
): Promise<Array<{ userId: string; role: ProjectRole }>> {
  const results = await db
    .select({
      userId: projectMembers.userId,
      role: projectMembers.role,
    })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId));

  return results as Array<{ userId: string; role: ProjectRole }>;
}

/**
 * Get user's role in a specific project.
 */
export async function getUserProjectRole(
  userId: string,
  projectId: string
): Promise<ProjectRole | null> {
  const result = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.userId, userId),
        eq(projectMembers.projectId, projectId)
      )
    )
    .limit(1);

  return result.length > 0 ? (result[0].role as ProjectRole) : null;
}
