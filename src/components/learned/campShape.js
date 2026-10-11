// The camp's shape right now (group and day counts), for "Your camp changed since you answered".
// Compared against the shape each answer recorded; null when it cannot be read, which means "no flag".
export async function currentCampShape(client) {
  try {
    const [groups, days] = await Promise.all([client.list('groups'), client.list('days_of_operation')])
    return { groups: groups.length, days: days.length }
  } catch {
    return null
  }
}
