 // sync-prices.js
const { createClient } = require('@supabase/supabase-js')
const fetch = require('node-fetch')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const PRISYNC_API_KEY = process.env.PRISYNC_API_KEY
const PRISYNC_API_TOKEN = process.env.PRISYNC_API_TOKEN
const PRISYNC_BASE_URL = 'https://prisync.com/api/v2'

async function fetchAllPrisyncProducts() {
  try {
    let allProducts = []
    let startFrom = 0
    let hasMore = true
    
    while (hasMore) {
      const response = await fetch(`${PRISYNC_BASE_URL}/list/product/summary/startFrom/${startFrom}`, {
        headers: {
          'apikey': PRISYNC_API_KEY,
          'apitoken': PRISYNC_API_TOKEN
        }
      })
      
      if (!response.ok) {
        throw new Error(`Prisync API error: ${response.status}`)
      }
      
      const data = await response.json()
      const products = data.results || []
      
      allProducts = allProducts.concat(products)
      
      // Check if there are more pages
      hasMore = data.nextURL && products.length === 100
      startFrom += 100
      
      console.log(`Fetched ${products.length} products from Prisync (total: ${allProducts.length})`)
      
      if (hasMore) {
        // Add small delay between requests
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }
    
    return allProducts
  } catch (error) {
    console.error('Error fetching Prisync products:', error)
    throw error
  }
}

function findMatchingPrisyncProduct(databaseProductName, prisyncProducts) {
  console.log(`Looking for Prisync match for: "${databaseProductName}"`)
  
  for (const prisyncProduct of prisyncProducts) {
    const prisyncName = prisyncProduct.name.toLowerCase().trim()
    const dbName = databaseProductName.toLowerCase().trim()
    
    console.log(`  Comparing with Prisync product: "${prisyncProduct.name}"`)
    
    // Check for exact match
    if (prisyncName === dbName) {
      console.log(`  ✓ Exact match found!`)
      
      // Extract price from summary object
      let price = null
      if (prisyncProduct.summary) {
        // Get the first available price from any site in the summary
        const sites = Object.keys(prisyncProduct.summary)
        for (const site of sites) {
          if (prisyncProduct.summary[site] && prisyncProduct.summary[site].price) {
            price = parseFloat(prisyncProduct.summary[site].price)
            console.log(`  ✓ Found price from ${site}: $${price}`)
            break
          }
        }
      }
      
      if (price && price > 0) {
        return {
          product: prisyncProduct,
          price: price
        }
      } else {
        console.log(`  - Product found but no price available in summary`)
        return null
      }
    }
  }
  
  console.log(`  ✗ No match found for "${databaseProductName}"`)
  return null
}

async function updateDatabasePrices() {
  // Get all products from database
  const { data: products, error: fetchError } = await supabase
    .from('bags')
    .select('id, product_link, normal_retail_price, bag_name')
    .not('product_link', 'is', null)
  
  if (fetchError) {
    console.error('Error fetching products from database:', fetchError)
    throw fetchError
  }
  
  console.log(`Found ${products.length} products in database`)
  
  // Get all products from Prisync
  const prisyncProducts = await fetchAllPrisyncProducts()
  console.log(`Found ${prisyncProducts.length} products in Prisync`)
  
  const results = {
    successful: 0,
    failed: 0,
    errors: []
  }
  
  for (const product of products) {
    try {
      const match = findMatchingPrisyncProduct(product.bag_name, prisyncProducts)
      
      if (match && match.price) {
        const currentPrice = match.price
        
        const { error: updateError } = await supabase
          .from('bags')
          .update({ 
            normal_retail_price: currentPrice,
            last_price_update: new Date().toISOString()
          })
          .eq('id', product.id)
        
        if (updateError) {
          throw updateError
        }
        
        results.successful++
        console.log(`✓ Updated product ${product.id}: $${currentPrice} (matched with Prisync product: ${match.product.name})`)
      } else {
        throw new Error(`No matching product found in Prisync for URL: ${product.product_link}`)
      }
      
    } catch (error) {
      results.failed++
      results.errors.push({
        product_id: product.id,
        product_link: product.product_link,
        error: error.message
      })
      console.error(`✗ Failed to update product ${product.id}:`, error.message)
    }
  }
  
  return results
}

async function main() {
  try {
    console.log('🚀 Starting Prisync price sync...')
    
    const results = await updateDatabasePrices()
    
    console.log('\n📊 Sync Results:')
    console.log(`✓ Successful updates: ${results.successful}`)
    console.log(`✗ Failed updates: ${results.failed}`)
    
    if (results.errors.length > 0) {
      console.log('\n❌ Errors:')
      results.errors.forEach(error => {
        console.log(`  - Product ${error.product_id}: ${error.error}`)
      })
    }
    
  } catch (error) {
    console.error('💥 Price sync failed:', error)
    process.exit(1)
  }
}

main()
