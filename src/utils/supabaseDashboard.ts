
import { supabase } from '../supabase';

// Define a type for the database client mapping
interface DatabaseClientMapping {
  name: string;
  location: string;
  deductiondate: string;
  policiescount: number;
  scheduledocsurl: string[];
  loadocurl: string[];
  pdfdocsurl: string[];
  policynumbers: string[];
  issuedate: string;
  products: ProductOption[];
  year: number;
  client_id?: string;
  created_at?: string;
  id?: string;
  policypremium?: string;
}

// Define the product options as a type
export type ProductOption = 'Value Funeral Plan' | 'Enhanced Priority Plan' | 'All in One Funeral' | 'Immediate Life Cover';

// Validate and ensure the product option is one of the allowed types
export function validateProductOption(product: any): ProductOption {
  const validProducts: ProductOption[] = [
    'Value Funeral Plan', 
    'Enhanced Priority Plan', 
    'All in One Funeral', 
    'Immediate Life Cover'
  ];

  if (typeof product !== 'string' || !validProducts.includes(product as ProductOption)) {
    // Default to the first product if invalid
    return validProducts[0];
  }

  return product as ProductOption;
}

// Helper to get table name for a month and year (e.g. 'clients_january')
export function getMonthlyTableName(monthIndex: number) {
  const months = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
  ];
  return `clients_${months[monthIndex]}`;
}

// Fetch all rows for a given month and year
export async function fetchMonthlyClients(monthIndex: number, year: number) {
  const table = getMonthlyTableName(monthIndex);
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .eq('year', year)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data;
}

// Helper to map camelCase client fields to all-lowercase, no-underscore
function mapClientForDb(client: any): DatabaseClientMapping {
  const dbClient: DatabaseClientMapping = {
    name: client.name || '',
    location: client.location || '',
    deductiondate: client.deductionDate || client.deductiondate || '',
    policiescount: Number(client.policiesCount || client.policiescount || 0),
    scheduledocsurl: Array.isArray(client.scheduleDocsUrl) ? client.scheduleDocsUrl : (client.scheduleDocsUrl ? [client.scheduleDocsUrl] : []),
    loadocurl: Array.isArray(client.loaDocUrl) ? client.loaDocUrl : (client.loaDocUrl ? [client.loaDocUrl] : []),
    pdfdocsurl: Array.isArray(client.pdfDocsUrl) ? client.pdfDocsUrl : (client.pdfDocsUrl ? [client.pdfDocsUrl] : []),
    policynumbers: Array.isArray(client.policyNumbers) ? client.policyNumbers : (client.policyNumbers ? [client.policyNumbers] : []),
    issuedate: client.issueDate || client.issuedate || '',
    products: client.products ? client.products.map(validateProductOption) : [],
    year: Number(client.year || new Date().getFullYear()),
    client_id: client.client_id,
    created_at: client.created_at,
    policypremium: client.policyPremium || client.policypremium || '',
  };

  // Conditionally add id if it exists
  if (client.id && typeof client.id === 'string') {
    dbClient.id = client.id;
  }

  return dbClient;
}

export async function addMonthlyClient(monthIndex: number, year: number, client: any) {
  const table = getMonthlyTableName(monthIndex);
  const dbClient = mapClientForDb(client);
  
  // Remove temporary ID if it exists
  if (dbClient.id && dbClient.id.startsWith('temp_')) {
    delete dbClient.id;
  }

  const { data, error } = await supabase
    .from(table)
    .insert([{ ...dbClient, year }])
    .select();
  if (error) throw new Error(error.message);
  
  // Make sure to update the global clients table
  await updateGlobalClientFromMonthly(client);
  
  return data?.[0];
}

// Update a row in a monthly table
export async function updateMonthlyClient(monthIndex: number, year: number, id: string, updates: any) {
  const table = getMonthlyTableName(monthIndex);
  const dbUpdates = mapClientForDb(updates);
  
  // FIX: Ensure the policy premium is properly saved
  if (updates.policyPremium !== undefined) {
    dbUpdates.policypremium = updates.policyPremium;
  }
  
  const { data, error } = await supabase
    .from(table)
    .update(dbUpdates)
    .eq('id', id)
    .eq('year', year)
    .select();
  if (error) throw new Error(error.message);
  
  // Also update in the global clients table
  await updateGlobalClientFromMonthly(updates);
  
  return data?.[0];
}

// Delete a row in a monthly table
export async function deleteMonthlyClient(monthIndex: number, year: number, id: string) {
  const table = getMonthlyTableName(monthIndex);
  // First, get the client to be deleted to update global table
  const { data: clientData } = await supabase
    .from(table)
    .select('*')
    .eq('id', id)
    .eq('year', year)
    .single();
  
  // Delete from monthly table
  const { error } = await supabase
    .from(table)
    .delete()
    .eq('id', id)
    .eq('year', year);
  if (error) throw new Error(error.message);
  
  // Update global clients table to reflect the removal
  if (clientData) {
    await updateGlobalClientsAfterDelete(clientData.name);
  }
  
  return true;
}

// Helper function to update or create a client in the global clients table
async function updateGlobalClientFromMonthly(client: any) {
  if (!client.name) return;
  
  console.log('Updating global client from monthly:', client.name);
  
  // Get all monthly data for this client to aggregate
  const { data: allMonthlyData } = await getAllMonthlyDataForClient(client.name);
  
  if (!allMonthlyData || allMonthlyData.length === 0) return;
  
  // Aggregate data from all months
  const aggregatedData = aggregateClientData(allMonthlyData);
  
  // Always perform an upsert to ensure all data is captured
  const { error } = await supabase
    .from('clients')
    .upsert({
      name: client.name,
      ...aggregatedData
    }, {
      onConflict: 'name'
    });
  
  if (error) {
    console.error('Error updating global client:', error);
    throw error;
  }
}

// Helper function to update global clients table after a monthly record is deleted
async function updateGlobalClientsAfterDelete(clientName: string) {
  // Get all remaining data for this client
  const { data: remainingData } = await getAllMonthlyDataForClient(clientName);
  
  if (!remainingData || remainingData.length === 0) {
    // If no data left, delete from global table
    await supabase
      .from('clients')
      .delete()
      .eq('name', clientName);
  } else {
    // Otherwise update with aggregated data from remaining months
    const aggregatedData = aggregateClientData(remainingData);
    await supabase
      .from('clients')
      .update(aggregatedData)
      .eq('name', clientName);
  }
}

// Helper to get all monthly data for a client
async function getAllMonthlyDataForClient(clientName: string) {
  const months = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
  ];
  
  const allData = [];
  
  for (const month of months) {
    const { data } = await supabase
      .from(`clients_${month}`)
      .select('*')
      .eq('name', clientName);
    
    if (data && data.length > 0) {
      allData.push(...data);
    }
  }
  
  return { data: allData };
}

// Helper to aggregate client data across months
function aggregateClientData(monthlyData: any[]) {
  if (!monthlyData || monthlyData.length === 0) return {};
  
  // Start with data from the latest record for non-numerical fields
  const latestRecord = monthlyData.sort((a, b) => 
    new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
  )[0];
  
  // Initialize with location from the latest record
  const result = {
    location: latestRecord.location,
    products: [],
    policies_count: 0,
    policy_numbers: [],
    policy_premium: 0,
  };
  
  // Aggregate numerical values and arrays
  monthlyData.forEach(record => {
    // Sum up policy count
    result.policies_count += (record.policiescount || 0);
    
    // Combine products without duplicates
    if (record.products) {
      const products = Array.isArray(record.products) ? record.products : [];
      products.forEach(product => {
        if (!result.products.includes(product)) {
          result.products.push(product);
        }
      });
    }
    
    // Combine policy numbers without duplicates
    if (record.policynumbers) {
      const policyNumbers = Array.isArray(record.policynumbers) ? record.policynumbers : [];
      policyNumbers.forEach(number => {
        if (!result.policy_numbers.includes(number)) {
          result.policy_numbers.push(number);
        }
      });
    }
    
    // Sum up policy premium (convert from string if needed)
    if (record.policypremium) {
      let premium = 0;
      // Handle various input formats
      const premiumStr = String(record.policypremium)
        .replace(/[R\s]/g, '') // Remove 'R' and whitespace
        .replace(/,/g, ''); // Remove commas
      
      // Try parsing as float
      const parsedPremium = parseFloat(premiumStr);
      
      // Validate and add to total
      if (!isNaN(parsedPremium) && parsedPremium > 0) {
        result.policy_premium += parsedPremium;
      }
    }
  });
  
  return result;
}

// CRUD for global clients table
export async function fetchAllClients() {
  const { data, error } = await supabase
    .from('clients')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data;
}

// Delete client from all tables (both global and all monthly tables)
export async function deleteClient(name: string) {
  if (!name) throw new Error("Client name is required");
  
  // First delete all monthly records for this client
  const months = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
  ];
  
  // Delete from all monthly tables in parallel for efficiency
  const deletePromises = months.map(month => 
    supabase
      .from(`clients_${month}`)
      .delete()
      .eq('name', name)
  );
  
  // Execute all delete operations
  await Promise.all(deletePromises);
  
  // Then delete from global table
  const { error } = await supabase
    .from('clients')
    .delete()
    .eq('name', name);
  
  if (error) throw new Error(error.message);
  
  return true;
}

// PDF upload helper
export async function uploadPdf(file: File, path: string) {
  // Create path components first - fix for storage permissions
  const pathParts = path.split('/');
  if (pathParts.length > 1) {
    try {
      // Check if folder exists first to avoid errors
      const { data: existingFolder } = await supabase.storage
        .from('pdfs')
        .list(pathParts[0]);
      
      if (!existingFolder || existingFolder.length === 0) {
        // Create an empty file to initialize the folder
        await supabase.storage
          .from('pdfs')
          .upload(`${pathParts[0]}/.folder`, new Blob(['']));
      }
    } catch (error) {
      console.error("Error checking/creating folder:", error);
      // Continue anyway as the main upload might work
    }
  }

  const { data, error } = await supabase.storage
    .from('pdfs')
    .upload(path, file, {
      cacheControl: '3600',
      upsert: true // Changed to true to overwrite existing files with same name
    });

  if (error) {
    console.error("PDF upload error:", error);
    throw new Error(error.message);
  }
  
  return supabase.storage.from('pdfs').getPublicUrl(path).data.publicUrl;
}
