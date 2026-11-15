// The restaurant menu card (design/Menu/Page 1-6) as data, for the two operator catalog templates in seed.ts.
// Prices are rupees, tax-exclusive ("GST 5% Extra" on the card). Spelling is corrected from the card.
// A line is [name, rupees] and takes its section's diet; a third element overrides it. Eggs are 'egg', never veg.
// Transcribed from small images: check prices against the card before they reach a real tenant.
type Diet = 'veg' | 'egg' | 'non_veg';
type Line = readonly [name: string, rupees: number, diet?: Diet];
interface Section { category: string; diet: Diet; items: readonly Line[] }

export const GST_BP = 500;
export const HSN = '996331'; // restaurant service

const E = 'egg', N = 'non_veg';

const SECTIONS: readonly Section[] = [
  { category: 'Breakfast', diet: 'veg', items: [
    ['Poori Bhaji', 119], ['Aloo Paratha', 119], ['Plain Paratha', 79], ['Veg Sandwich', 119], ['Chicken Sandwich', 179, N],
    ['Bread Omelet', 149, E], ['Corn Flakes with Hot Milk 1 Bowl', 129], ['Fresh Fruits Basket', 199], ['Chole Bhature', 129], ['Bread Toast', 89],
    ['Omelette 2 Eggs (Plain)', 69, E], ['Omelette 2 Eggs (Masala)', 89, E], ['Omelette 2 Eggs (Poached)', 79, E], ['Boiled Eggs', 99, E],
    ['Idli Chutney Sambalpuri Style', 99]] },
  { category: 'Salad / Papad / Raita', diet: 'veg', items: [
    ['Green Salad', 69], ['Onion Salad', 49], ['Tomato Kheera Salad', 69], ['Papad (Dry)', 29], ['Papad (Fry)', 34],
    ['Papad Masala (Dry)', 49], ['Papad Masala (Fry)', 54], ['Mix Veg Raita', 69], ['Boondi / Bujia Raita', 79], ['Plain Curd', 49],
    ['Sugar Curd', 59], ['Pineapple Raita', 79]] },
  { category: 'Noodles', diet: 'veg', items: [
    ['Veg Noodles', 134], ['Veg Hakka Noodles', 144], ['Garlic Noodles', 164], ['Schezwan Noodles', 149], ['Hong Kong Noodles', 179],
    ['Mushroom Noodles', 149], ['Baby Corn Noodles', 149], ['Veg Mix Noodles', 169], ['Paneer Noodles', 149],
    ['Egg Chicken Noodles', 179, N], ['Egg Noodles', 159, E], ['Schezwan Chicken Noodles', 179, N], ['Non Veg Mix Noodles', 199, N]] },
  { category: 'Soup', diet: 'veg', items: [
    ['Veg Manchow Soup', 129], ['Hot N Sour Soup', 129], ['Veg Noodle Soup', 99], ['Mushroom Soup', 129], ['Tomato Soup', 124],
    ['Lemon Coriander Soup', 124], ['Sweet Corn Soup', 109], ['Hot Garlic Soup', 109],
    ['Chicken Manchow Soup', 109, N], ['Lung Fung Soup', 139, N], ['Chicken Noodles Soup', 129, N], ['Chicken Garlic Soup', 129, N],
    ['Chicken Hot N Sour Soup', 129, N], ['Egg Chicken Soup', 149, N], ['Egg Soup', 109, E]] },
  { category: 'Roll', diet: 'veg', items: [['Veg Spring Roll', 119], ['Paneer Spring Roll', 179], ['Chicken Spring Roll', 199, N]] },
  { category: 'Momos', diet: 'veg', items: [
    ['Veg Momos', 99], ['Paneer Momos', 129], ['Veg Fried Momos', 129], ['Paneer Fried Momos', 149], ['Chicken Momos', 149, N], ['Chicken Fried Momos', 179, N]] },
  { category: 'Bread Basket', diet: 'veg', items: [
    ['Tawa Roti', 20], ['Tawa Butter Roti', 30], ['Tandoori Roti', 30], ['Tandoori Butter Roti', 40], ['Plain Naan', 60], ['Butter Naan', 70],
    ['Garlic Naan', 75], ['Rajasthani Naan', 80], ['Punjabi Naan', 80], ['Plain Kulcha', 60], ['Masala Kulcha', 75], ['Lachha Paratha', 60],
    ['Tandoori Basket 5 Items', 350]] },
  { category: 'Starters - Veg', diet: 'veg', items: [
    ['Veg Manchurian', 169], ['Gobi Manchurian', 169], ['Gobi Chilli', 179], ['Paneer Manchurian', 179], ['Mushroom Manchurian', 199],
    ['Honey Chilli Potato', 139], ['Baby Corn Chilli', 179], ['Mushroom Chilli', 199], ['Mushroom Salt N Pepper', 209], ['Mushroom Pepper Dry', 199],
    ['Finger Chips', 129], ['American Corn', 159], ['Corn Dry', 159], ['Chana Dry Fry', 159], ['Chana Chilli', 159], ['Veg Pakoda', 149],
    ['One Ten Veg', 159], ['Veg Kurkure', 159], ['Veg Bullet', 159], ['Onion Pakoda', 149], ['Paneer Kurkure', 219], ['Paneer Chilli', 219],
    ['Thread Paneer', 229], ['Paneer 65', 219], ['Paneer Salt N Pepper', 199], ['Paneer Yoga', 209], ['Paneer Majestic', 219],
    ['Apollo Paneer', 209], ['Dragon Potato', 159]] },
  { category: 'Starters - Non Veg', diet: 'non_veg', items: [
    ['Chicken Manchurian (BL)', 263], ['Chicken Chilli (BL)', 239], ['Chicken Chilli (Bone)', 219], ['Chicken 65', 249], ['Chicken Majestic (BL)', 259],
    ['Dragon Chicken (BL)', 259], ['Lemon Chicken (BL)', 259], ['Chicken Lollipop', 259], ['Egg Manchurian', 179, E], ['Egg Pakoda', 169, E],
    ['Egg Chilli', 179, E], ['Egg Yellora', 179, E], ['Egg 65', 169, E], ['Mutton Manchurian (Bone)', 279], ['Mutton Chilli (Bone)', 299],
    ['Mutton 65 (Bone)', 299], ['Fish Fry', 129], ['Fish Finger', 249], ['Fish Chilli (BL)', 249], ['Chicken Pakoda (BL)', 239],
    ['Chicken Pakoda (Bone)', 239], ['Garlic Chicken (B/BL)', 249], ['Schezwan Chicken (B/BL)', 249], ['Prawn Fry', 334], ['Chicken Drumstick', 259],
    ['Chicken Roasted', 259], ['Prawn Golden Fried', 299], ['Ginger Chicken (B/BL)', 249], ['Chicken Kurkure (BL)', 239]] },
  { category: 'Rice', diet: 'veg', items: [
    ['Plain Rice', 79], ['Jeera Rice', 89], ['Lemon Rice', 129], ['Curd Rice', 129], ['Veg Pulao', 169], ['Kashmiri Pulao', 199], ['Veg Fried Rice', 139],
    ['Masala Rice', 139], ['Schezwan Rice', 149], ['Mix Fried Rice (Veg)', 209], ['Mushroom Fried Rice', 159], ['Baby Corn Fried Rice', 159],
    ['Paneer Fried Rice', 199], ['Egg Chicken Fried Rice', 179, N], ['Egg Fried Rice', 139, E], ['Mix Fried Rice (Non Veg)', 239, N],
    ['Chicken Schezwan Fried Rice', 159, N], ['Mutton Fried Rice', 299, N], ['Prawn Fried Rice', 309, N]] },
  { category: 'Biryani', diet: 'veg', items: [
    ['Veg Biryani', 179], ['Veg 65 Biryani', 199], ['Paneer Biryani', 239], ['Paneer 65 Biryani', 259], ['Chicken Biryani (With Egg)', 254, N],
    ['Chicken Fry Piece Biryani', 239, N], ['Chicken 65 Biryani', 269, N], ['Chicken Pulao', 239, N], ['Egg Biryani', 189, E], ['Egg 65 Biryani', 219, E],
    ['Mutton Biryani', 319, N], ['Mutton 65 Biryani', 339, N], ['Mutton Pulao', 354, N]] },
  { category: 'Dal', diet: 'veg', items: [
    ['Plain Dal', 79], ['Dal Tadka Yellow', 109], ['Dal Tadka Black', 134], ['Dal Fry Yellow', 99], ['Dal Makhani', 139], ['Dal Maharani', 139],
    ['Dal Maharaja', 129], ['Dal Lasuni Mirchi', 119], ['Dal Kolhapuri', 109], ['Dal Punjabi', 109], ['Punjabi Tadka', 119],
    ['Egg Tadka Black', 129, E], ['Egg Tadka Yellow', 129, E], ['Veg Patiyala', 179]] },
  { category: 'Veg Dishes', diet: 'veg', items: [
    ['Mix Vegetable Curry', 179], ['Veg Kadhai', 219], ['Veg Do Pyaza', 209], ['Veg Jaipuri', 209], ['Veg Jhalfry', 199], ['Veg Kolhapuri', 199],
    ['Veg Navaratna Korma', 229], ['Malai Kofta', 239], ['Veg Kofta', 229], ['Veg Korma', 189], ['Veg Kundan Masala', 229], ['Green Peas Masala', 169],
    ['Meethi Paneer', 209], ['Kasturi Vegetable', 209], ['Chana Masala', 169], ['Alu Dum Masala', 149], ['Kashmiri Alu Dum (Sweet)', 189],
    ['Alu Matar Curry', 159], ['Alu Jeera / Alu Bhaja', 149], ['Bhindi Bhaja', 149], ['Stuffed Capsicum Masala', 219], ['Bhindi / Alu Putal Masala', 159],
    ['Alugobi Fry Masala', 159], ['Patta Gobi Matar Sabji', 159], ['Baigan Aloo Bharta', 139]] },
  { category: 'Paneer', diet: 'veg', items: [
    ['Paneer Masala', 199], ['Paneer Butter Masala', 219], ['Paneer Mutter Masala', 199], ['Paneer Lababdar', 239], ['Palak Paneer', 229],
    ['Paneer Kadhai', 239], ['Paneer Punjabi', 239], ['Paneer Hyderabadi', 229], ['Sahi Paneer', 239], ['Paneer Pasanda', 239], ['Paneer Sahi Korma', 239],
    ['Paneer Bharta', 179], ['Paneer Bhurji', 179], ['Kaju Paneer Curry', 259], ['Paneer Tikka Masala', 299], ['Paneer Patiyala', 219]] },
  { category: 'Mushroom', diet: 'veg', items: [
    ['Mushroom Masala', 199], ['Mushroom Butter Masala', 209], ['Mushroom Kadhai', 219], ['Mushroom Do Pyaza', 219], ['Mushroom Mutter Masala', 199],
    ['Mushroom Kolhapuri', 219], ['Mushroom Kofta', 239]] },
  { category: 'Chicken', diet: 'non_veg', items: [
    ['Chicken Curry', 189], ['Chicken Masala', 199], ['Chicken Kasa', 189], ['Chicken Lotpot', 189], ['Chicken Butter Masala', 319], ['Chicken Kadhai', 299],
    ['Chicken Hyderabadi', 299], ['Chicken Punjabi', 299], ['Chicken Kolhapuri', 219], ['Chicken Do Pyaza', 299], ['Chicken Lahori', 299],
    ['Chicken Tikka Masala', 299], ['Chicken Leg Butter Masala', 309]] },
  { category: 'Mutton', diet: 'non_veg', items: [
    ['Mutton Curry', 299], ['Mutton Kasa', 319], ['Mutton Rogan Josh', 319], ['Mutton Kolhapuri', 319], ['Mutton Do Pyaza', 319], ['Mutton Kadhai', 329],
    ['Mutton Lotpot', 319], ['Mutton Masala', 319], ['Mutton Butter Masala', 349], ['Mutton Hyderabadi', 349], ['Mutton Punjabi', 349]] },
  { category: 'Prawn', diet: 'non_veg', items: [
    ['Prawn Masala', 339], ['Prawn Curry', 349], ['Prawn Kadhai', 349], ['Prawn Do Pyaza', 359], ['Prawn Butter Masala', 379], ['Prawn Malai Curry', 379]] },
  { category: 'Fish', diet: 'non_veg', items: [
    ['Fish Curry', 159], ['Fish Masala', 179], ['Fish Green Peas Masala', 179], ['Fish Butter Masala', 219], ['Fish Bengali Curry', 169]] },
  { category: 'Egg', diet: 'egg', items: [
    ['Egg Bhurji', 79], ['Egg Bhurji Curry', 109], ['Egg Masala', 139], ['Egg Curry', 119], ['Egg Do Pyaza', 149], ['Egg Keema Masala', 129],
    ['Egg Kolhapuri', 149], ['Egg Boiled Fry', 99]] },
  { category: 'Tandoori - Chicken', diet: 'non_veg', items: [
    ['Tandoori Chicken (Half)', 369], ['Tandoori Chicken (Full)', 519], ['Chicken Tikka', 399], ['Hariyali Tikka', 319], ['Chicken Malai Tikka', 349],
    ['Chicken Achari Tikka', 299], ['Chicken Tangdi Kabab', 299], ['Chicken Seekh Kabab', 349], ['Chicken Boti Kabab', 349], ['Chicken Reshmi Kabab', 319],
    ['Chicken Afghani Tikka', 349], ['Non Veg Platter', 799]] },
  { category: 'Tandoori - Veg', diet: 'veg', items: [
    ['Paneer Tikka', 279], ['Paneer Achari Tikka', 279], ['Paneer Malai Tikka', 319], ['Paneer Hariyali Tikka', 279], ['Mushroom Tikka', 249],
    ['Veg Tandoor Platter', 449]] },
  { category: 'Tandoori - Fish / Prawn', diet: 'non_veg', items: [
    ['Fish Tikka', 309], ['Prawn Tikka', 379], ['Prawn Malai Tikka', 419], ['Pomfret Fish', 599]] },
  { category: 'Beverage / Dessert', diet: 'veg', items: [
    ['Tea', 25], ['Coffee', 35], ['Lemon Tea', 20], ['Tea With Sugar', 25], ['Hot Milk', 60], ['Milk Shake Vanilla', 120], ['Fruit Juice', 80],
    ['Butter Milk', 60], ['Salted / Sweet Lassi', 80], ['Cold Drinks 200ml', 35], ['Soda 500ml', 35], ['Masala Cold Drink', 55],
    ['Packaged Water', 20], ['Tea Pot 4 Tea', 100], ['Ice Cream 2 Scoop', 80], ['Gulab Jamun 2pc', 80]] },
];

/** Dish photos cropped from the card (scripts/assets/menu), by the item each one shows. */
export const PHOTOS: Record<string, string> = {
  'Veg Sandwich': 'p1-a', 'Bread Omelet': 'p1-b', 'Green Salad': 'p1-c', 'Veg Noodles': 'p1-d', 'Non Veg Mix Noodles': 'p1-e',
  'Sweet Corn Soup': 'p2-a', 'Chicken Hot N Sour Soup': 'p2-b', 'Veg Spring Roll': 'p2-c', 'Veg Fried Momos': 'p2-d', 'Tandoori Roti': 'p2-e',
  'Veg Manchurian': 'p3-a', 'American Corn': 'p3-b', 'Chicken Drumstick': 'p3-c', 'Chicken Chilli (BL)': 'p3-d', 'Veg Biryani': 'p4-a',
  'Tandoori Chicken (Half)': 'p6-a', 'Paneer Tikka': 'p6-b', 'Prawn Tikka': 'p6-c', 'Cold Drinks 200ml': 'p6-d',
};

export interface CardItem { name: string; pricePaise: number; diet: Diet; photo?: string }
export interface CardCategory { name: string; items: CardItem[] }

/** The card as categories in card order. `vegOnly` keeps only veg lines (no egg, no meat) and drops categories left empty. */
export function menuCard(vegOnly: boolean): CardCategory[] {
  return SECTIONS
    .map((s) => ({
      name: s.category,
      items: s.items
        .map(([name, rupees, diet]): CardItem => ({ name, pricePaise: rupees * 100, diet: diet ?? s.diet, ...(PHOTOS[name] ? { photo: PHOTOS[name] } : {}) }))
        .filter((i) => !vegOnly || i.diet === 'veg'),
    }))
    .filter((c) => c.items.length > 0);
}
